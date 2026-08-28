import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { finishRun, openDatabase } from "../src/server/db.js";
import { RunCoordinator } from "../src/server/coordinator.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function runRow(db: ReturnType<typeof openDatabase>, id: string) {
  return db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
}

function insertJob(db: ReturnType<typeof openDatabase>, id: string) {
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id,
    id,
    "fixture",
    `https://example.test/${id}`,
    "Fixture",
    "Engineer",
    "Fixture posting",
    80,
    JSON.stringify({ reason: "fixture", strengths: [], gaps: [] }),
    "Selected",
    "2026-08-28T00:00:00.000Z",
    "2026-08-28T00:00:00.000Z",
  );
}

function enqueue(coordinator: RunCoordinator, options: Partial<Parameters<RunCoordinator["enqueue"]>[0]> = {}) {
  return coordinator.enqueue({
    workflow: "test",
    provider: "fixture",
    model: "phase4",
    execute: async () => ({ ok: true }),
    ...options,
  });
}

test("queued runs preserve admission order", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db });
  const firstGate = deferred();
  const order: string[] = [];
  try {
    const first = await enqueue(coordinator, { execute: async () => { order.push("first"); await firstGate.promise; return "one"; } });
    await waitFor(() => runRow(db, first)?.status, (status) => status === "running");
    const second = await enqueue(coordinator, { execute: async () => { order.push("second"); return "two"; } });
    const third = await enqueue(coordinator, { execute: async () => { order.push("third"); return "three"; } });
    assert.equal(runRow(db, second)?.status, "queued");
    assert.equal(runRow(db, third)?.status, "queued");

    firstGate.resolve();
    await waitFor(() => runRow(db, third)?.status, (status) => status === "succeeded");
    assert.deepEqual(order, ["first", "second", "third"]);
  } finally {
    db.close();
  }
});

test("same-job runs queue behind the resource lock", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db });
  const firstGate = deferred();
  const order: string[] = [];
  try {
    insertJob(db, "job-a");
    const first = await enqueue(coordinator, { jobId: "job-a", execute: async () => { order.push("first"); await firstGate.promise; } });
    await waitFor(() => runRow(db, first)?.status, (status) => status === "running");
    const second = await enqueue(coordinator, { jobId: "job-a", execute: async () => { order.push("second"); } });
    assert.equal(runRow(db, second)?.status, "queued");
    firstGate.resolve();
    await waitFor(() => runRow(db, second)?.status, (status) => status === "succeeded");
    assert.deepEqual(order, ["first", "second"]);
  } finally {
    db.close();
  }
});

test("different jobs queue independently under global concurrency one", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db, concurrency: 1 });
  const firstGate = deferred();
  try {
    insertJob(db, "job-a");
    insertJob(db, "job-b");
    const first = await enqueue(coordinator, { jobId: "job-a", execute: async () => { await firstGate.promise; } });
    await waitFor(() => runRow(db, first)?.status, (status) => status === "running");
    const second = await enqueue(coordinator, { jobId: "job-b", execute: async () => "second" });
    assert.equal(runRow(db, second)?.status, "queued");
    firstGate.resolve();
    await waitFor(() => runRow(db, second)?.status, (status) => status === "succeeded");
  } finally {
    db.close();
  }
});

test("different jobs can run independently when configured concurrency allows it", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db, concurrency: 2 });
  const firstGate = deferred();
  const sameJobOrder: string[] = [];
  let differentJobStarted = false;
  try {
    insertJob(db, "job-a");
    insertJob(db, "job-b");
    const first = await enqueue(coordinator, { jobId: "job-a", execute: async () => { sameJobOrder.push("first"); await firstGate.promise; } });
    await waitFor(() => runRow(db, first)?.status, (status) => status === "running");
    const conflicting = await enqueue(coordinator, { jobId: "job-a", execute: async () => { sameJobOrder.push("conflicting"); } });
    const independent = await enqueue(coordinator, { jobId: "job-b", execute: async () => { differentJobStarted = true; } });

    await waitFor(() => runRow(db, independent)?.status, (status) => status === "succeeded");
    assert.equal(differentJobStarted, true);
    assert.equal(runRow(db, conflicting)?.status, "queued");
    firstGate.resolve();
    await waitFor(() => runRow(db, conflicting)?.status, (status) => status === "succeeded");
    assert.deepEqual(sameJobOrder, ["first", "conflicting"]);
  } finally {
    db.close();
  }
});

test("queued cancellation removes work and writes a terminal status", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db });
  const firstGate = deferred();
  let cancelledExecuted = false;
  try {
    const first = await enqueue(coordinator, { execute: async () => { await firstGate.promise; } });
    await waitFor(() => runRow(db, first)?.status, (status) => status === "running");
    const queued = await enqueue(coordinator, { execute: async () => { cancelledExecuted = true; } });
    assert.equal(coordinator.cancel(queued), true);
    assert.equal(runRow(db, queued)?.status, "cancelled");
    firstGate.resolve();
    await waitFor(() => runRow(db, first)?.status, (status) => status === "succeeded");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cancelledExecuted, false);
  } finally {
    db.close();
  }
});

test("active cancellation aborts the execution and persists cancellation", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db });
  try {
    const id = await enqueue(coordinator, {
      execute: async ({ signal }) => await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("provider stopped")), { once: true });
      }),
    });
    await waitFor(() => runRow(db, id)?.status, (status) => status === "running");
    assert.equal(coordinator.cancel(id), true);
    await waitFor(() => runRow(db, id)?.status, (status) => status === "cancelled");
    assert.equal(runRow(db, id)?.error_code, "cancelled");
  } finally {
    db.close();
  }
});

test("an idempotency key returns one persisted run", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db });
  const firstGate = deferred();
  let executions = 0;
  try {
    const options = {
      idempotencyKey: "request-42",
      execute: async () => { executions += 1; await firstGate.promise; },
    };
    const first = await enqueue(coordinator, options);
    const duplicate = await enqueue(coordinator, options);
    assert.equal(duplicate, first);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs WHERE idempotency_key=?").get("request-42") as { count: number }).count, 1);
    firstGate.resolve();
    await waitFor(() => runRow(db, first)?.status, (status) => status === "succeeded");
    assert.equal(executions, 1);
  } finally {
    db.close();
  }
});

test("coordinator startup reconciliation fails orphaned running and queued rows", () => {
  const db = openDatabase(":memory:");
  const runningId = randomUUID();
  const queuedId = randomUUID();
  db.prepare("INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES(?,?,?,?,?,?)").run(runningId, "test", "running", "fixture", "phase4", "2026-08-28T00:00:00.000Z");
  db.prepare("INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES(?,?,?,?,?,?)").run(queuedId, "test", "queued", "fixture", "phase4", "2026-08-28T00:00:00.000Z");
  try {
    new RunCoordinator({ db });
    assert.equal(runRow(db, runningId)?.status, "failed");
    assert.equal(runRow(db, runningId)?.error_code, "server_restart");
    assert.equal(runRow(db, queuedId)?.status, "failed");
    assert.equal(runRow(db, queuedId)?.error_code, "server_restart");
  } finally {
    db.close();
  }
});

test("terminal status writes are idempotent", () => {
  const db = openDatabase(":memory:");
  const id = randomUUID();
  db.prepare("INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES(?,?,?,?,?,?)").run(id, "test", "queued", "fixture", "phase4", new Date().toISOString());
  try {
    assert.equal(finishRun(db, id, "succeeded", { ok: true }, null, "none"), true);
    assert.equal(finishRun(db, id, "failed", null, "late failure", "provider"), false);
    assert.equal(runRow(db, id)?.status, "succeeded");
    assert.equal(runRow(db, id)?.error, null);
  } finally {
    db.close();
  }
});

test("locks release after failure", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db });
  let attempts = 0;
  try {
    insertJob(db, "job-a");
    const failed = await enqueue(coordinator, {
      jobId: "job-a",
      execute: async () => { attempts += 1; throw new Error("fixture failure"); },
    });
    const next = await enqueue(coordinator, {
      jobId: "job-a",
      execute: async () => { attempts += 1; return "recovered"; },
    });
    await waitFor(() => runRow(db, next)?.status, (status) => status === "succeeded");
    assert.equal(runRow(db, failed)?.status, "failed");
    assert.equal(attempts, 2);
  } finally {
    db.close();
  }
});

test("configured concurrency is never exceeded", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db, concurrency: 2 });
  let active = 0;
  let maximum = 0;
  try {
    for (let index = 0; index < 7; index += 1) insertJob(db, `job-${index}`);
    const ids = await Promise.all(Array.from({ length: 7 }, (_, index) => enqueue(coordinator, {
      jobId: `job-${index}`,
      execute: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    })));
    await Promise.all(ids.map((id) => waitFor(() => runRow(db, id)?.status, (status) => status === "succeeded")));
    assert.equal(maximum, 2);
  } finally {
    db.close();
  }
});

test("usage callbacks update run telemetry without changing lifecycle state", async () => {
  const db = openDatabase(":memory:");
  const coordinator = new RunCoordinator({ db });
  try {
    const id = await enqueue(coordinator, {
      execute: async ({ onUsage }) => {
        onUsage({ inputTokens: 4, outputTokens: 6, totalTokens: 10, estimatedCost: 0.25 });
        return "done";
      },
    });
    await waitFor(() => runRow(db, id)?.status, (status) => status === "succeeded");
    const row = runRow(db, id);
    assert.equal(row?.input_tokens, 4);
    assert.equal(row?.output_tokens, 6);
    assert.equal(row?.total_tokens, 10);
    assert.equal(row?.estimated_cost, 0.25);
  } finally {
    db.close();
  }
});
