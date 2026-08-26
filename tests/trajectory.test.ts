import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildServer } from "../src/server/app.js";
import { appendRunTrajectoryEvent, createTaskReporter, createTrajectoryRecorder, listRunTrajectoryEvents, openDatabase } from "../src/server/db.js";
import { runBoundedPi, type PiSessionLike } from "../src/server/pi.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { createMultiSourceScrapeExecutor, RunManager } from "../src/server/runs.js";
import { deriveRunTaskRows } from "../src/shared.js";

function insertRun(db: ReturnType<typeof openDatabase>, id: string = randomUUID()) {
  db.prepare("INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES(?,?,?,?,?,?)").run(id, "test", "running", "fake", "fixture", "2026-08-20T00:00:00.000Z");
  return id;
}

test("trajectory rows are ordered per run, tolerate bad JSON, and cascade with the run", () => {
  const db = openDatabase(":memory:");
  try {
    const runId = insertRun(db, "trajectory-db");
    appendRunTrajectoryEvent(db, runId, { kind: "user", type: "user_prompt", timestamp: "2026-08-20T00:00:01.000Z", payload: { text: "first" } });
    appendRunTrajectoryEvent(db, runId, { kind: "assistant", type: "assistant_message", timestamp: "2026-08-20T00:00:02.000Z", payload: { text: "second" } });
    db.prepare("UPDATE run_trajectory_events SET payload_json=? WHERE run_id=? AND sequence=2").run("not-json", runId);
    const events = listRunTrajectoryEvents(db, runId);
    assert.deepEqual(events.map((event) => [event.sequence, event.type]), [[1, "user_prompt"], [2, "assistant_message"]]);
    assert.deepEqual(events[0]?.payload, { text: "first" });
    assert.equal(events[1]?.payload, null);
    db.prepare("DELETE FROM runs WHERE id=?").run(runId);
    assert.equal((db.prepare("SELECT count(*) AS count FROM run_trajectory_events WHERE run_id=?").get(runId) as { count: number }).count, 0);
  } finally { db.close(); }
});

test("trajectory API returns a stable envelope and a safe 404", async () => {
  const db = openDatabase(":memory:");
  const runId = insertRun(db, "trajectory-api");
  appendRunTrajectoryEvent(db, runId, { kind: "lifecycle", type: "run_started", payload: null });
  const app = await buildServer({ db, dataDir: process.cwd() });
  try {
    const response = await app.inject({ url: `/api/runs/${runId}/trajectory` });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.json()), ["runId", "status", "events"]);
    assert.equal(response.json().events[0].type, "run_started");
    assert.equal((await app.inject({ url: "/api/runs/missing/trajectory" })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/runs?limit=1" })).json().runs.length, 1);
  } finally { await app.close(); db.close(); }
});

test("task telemetry is ordered, retry-safe, and source-specific", () => {
  const db = openDatabase(":memory:");
  const runId = insertRun(db, "trajectory-tasks");
  const reporter = createTaskReporter(createTrajectoryRecorder(db), runId);
  try {
    reporter.start({ taskId: "scrape:search:freehire", label: "Search FreeHire", detail: "FreeHire" });
    reporter.complete("scrape:search:freehire", "1 result from FreeHire");
    reporter.start({ taskId: "scrape:validate", label: "Validate and score results" });
    reporter.fail("scrape:validate", "Validation failed; retrying.");
    reporter.start({ taskId: "scrape:validate", label: "Validate and score results" });
    reporter.complete("scrape:validate", "1 result validated");
    const events = listRunTrajectoryEvents(db, runId);
    assert.deepEqual(events.filter((event) => event.type.startsWith("task_")).map((event) => event.type), ["task_started", "task_completed", "task_started", "task_failed", "task_started", "task_completed"]);
    const rows = deriveRunTaskRows(events, "scrape", "running");
    assert.deepEqual(rows.map((row) => [row.label, row.status, row.detail, row.attempt]), [
      ["Search FreeHire", "completed", "1 result from FreeHire", 1],
      ["Validate and score results", "completed", "1 result validated", 2],
    ]);
    assert.deepEqual(deriveRunTaskRows([], "interview", "running").map((row) => row.status), ["active", "pending", "pending"]);
  } finally { db.close(); }
});

test("scrape manager records enabled-source tasks and cancelled active tasks never look successful", async () => {
  const db = openDatabase(":memory:");
  const job = (source: string) => ({ sourceId: `${source}-1`, source, url: `https://example.test/${source}-1`, company: `${source} company`, role: "Backend Engineer", location: "Remote", posting: "Build APIs.", score: 81, reason: "Strong fit", strengths: ["APIs"], gaps: [] });
  const context = { profile: "Backend profile", criteria: { ...defaultCriteria, maxJobsPerRun: 5 }, settings: { ...defaultSettings, enabledSources: ["freehire", "linkedin"] } };
  const executor = createMultiSourceScrapeExecutor(async (_context, source) => {
    const value = job(source);
    return { result: { jobs: [value] }, provenance: new Map([[value.sourceId, value.url]]) };
  });
  const manager = new RunManager(db, executor, async () => context, createTrajectoryRecorder(db));
  try {
    const runId = await manager.start();
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((manager.get(runId) as { status?: string } | undefined)?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const events = listRunTrajectoryEvents(db, runId);
    const rows = deriveRunTaskRows(events, "scrape", "succeeded");
    assert.equal(rows.find((row) => row.taskId === "scrape:search:freehire")?.label, "Search FreeHire");
    assert.equal(rows.find((row) => row.taskId === "scrape:search:linkedin")?.label, "Search LinkedIn");
    assert.ok(events.findIndex((event) => event.type === "task_started" && (event.payload as { taskId?: string }).taskId === "scrape:search:freehire") < events.findIndex((event) => event.type === "task_completed" && (event.payload as { taskId?: string }).taskId === "scrape:search:freehire"));

    const cancelledEvents = [
      { runId: "cancelled", sequence: 1, kind: "lifecycle" as const, type: "task_started", timestamp: "2026-08-20T00:00:00.000Z", startedAt: null, endedAt: null, durationMs: null, payload: { taskId: "scrape:search:linkedin", label: "Search LinkedIn", detail: "LinkedIn", status: "started" as const } },
    ];
    const cancelledRows = deriveRunTaskRows(cancelledEvents, "scrape", "cancelled");
    assert.equal(cancelledRows[0]?.status, "failed");
    assert.equal(cancelledRows[0]?.detail, "LinkedIn");
    assert.notEqual(cancelledRows[0]?.detail, "Run succeeded.");
    assert.equal(deriveRunTaskRows([], "follow_up", "cancelled")[0]?.detail, "Run cancelled.");
  } finally { db.close(); }
});

class TrajectoryFakeSession implements PiSessionLike {
  private listener: ((event: unknown) => void) | null = null;
  disposed = false;
  promptText = "";
  readonly systemPrompt = "You are a trajectory test assistant.";
  subscribe(listener: (event: unknown) => void) { this.listener = listener; return () => { this.listener = null; }; }
  getActiveToolNames() { return ["lookupJob"]; }
  getAllTools() { return [{ name: "lookupJob", description: "Looks up one job.", parameters: { type: "object" } }]; }
  async prompt(text: string) {
    this.promptText = text;
    const emit = (event: unknown) => this.listener?.(event);
    const message = { role: "assistant", timestamp: Date.now(), content: [] };
    emit({ type: "agent_start" });
    emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "Answer" } });
    emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", delta: "Plan" } });
    emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "lookupJob", args: { id: "job-1" } });
    emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "lookupJob", args: { id: "job-1" }, partialResult: { stage: "loading" } });
    emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "lookupJob", result: { stage: "ready" }, isError: false });
    emit({ type: "message_end", message: { ...message, content: [{ type: "text", text: "Answer" }, { type: "thinking", thinking: "Plan" }] } });
    emit({ type: "agent_end", messages: [] });
    emit({ type: "agent_settled" });
  }
  async abort() {}
  dispose() { this.disposed = true; }
}

test("runBoundedPi persists prompts, aggregated assistant/thinking, tools, and terminal events", async () => {
  const db = openDatabase(":memory:");
  const runId = insertRun(db, "trajectory-pi");
  const recorder = createTrajectoryRecorder(db);
  const session = new TrajectoryFakeSession();
  try {
    await runBoundedPi({ runId, trajectory: recorder, prompt: "Exact user prompt", timeoutMs: 1_000, createSession: async () => session });
    assert.equal(session.promptText, "Exact user prompt");
    assert.equal(session.disposed, true);
    const events = listRunTrajectoryEvents(db, runId);
    const types = events.map((event) => event.type);
    for (const expected of ["system_prompt", "tool_catalog", "user_prompt", "agent_start", "turn_start", "assistant_message", "assistant_thinking", "tool_execution_start", "tool_execution_update", "tool_execution_end", "run_completed", "agent_settled", "session_disposed"]) assert.ok(types.includes(expected), expected);
    assert.equal((events.find((event) => event.type === "user_prompt")?.payload as { text: string }).text, "Exact user prompt");
    assert.equal((events.find((event) => event.type === "assistant_message")?.payload as { text: string }).text, "Answer");
    assert.equal((events.find((event) => event.type === "assistant_thinking")?.payload as { text: string }).text, "Plan");
    assert.equal((events.find((event) => event.type === "tool_execution_end")?.payload as { isError: boolean }).isError, false);
  } finally { db.close(); }
});
