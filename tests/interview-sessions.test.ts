import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings } from "../src/server/config.js";
import type { InterviewMessage } from "../src/shared.js";
import type { PiSessionLike } from "../src/server/pi.js";
import { PiRunCancelledError } from "../src/server/pi.js";
import { InterviewSessionPool, type InterviewSessionRun } from "../src/server/interview-sessions.js";

type FakeBehavior = "ok" | "fail" | "hang";

class FakeSession implements PiSessionLike {
  readonly promptTexts: string[] = [];
  disposed = false;
  abortCalls = 0;
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(
    readonly systemPrompt: string,
    private readonly response: string,
    private readonly behavior: FakeBehavior = "ok",
  ) {}

  subscribe(listener: (event: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string) {
    if (this.disposed) throw new Error("session disposed");
    this.promptTexts.push(text);
    if (this.behavior === "fail") throw new Error("provider failed");
    if (this.behavior === "hang") await new Promise<void>(() => {});
    const timestamp = this.promptTexts.length;
    for (const delta of this.response.match(/.{1,4}/gs) ?? []) {
      const message = { role: "assistant", timestamp, content: [] };
      for (const listener of this.listeners) listener({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", delta },
      });
    }
  }

  async abort() {
    this.abortCalls += 1;
  }

  dispose() {
    this.disposed = true;
  }
}

function runInput(input: Partial<InterviewSessionRun> & Pick<InterviewSessionRun, "jobId" | "systemPrompt" | "prompt" | "rebuildPrompt">): InterviewSessionRun {
  return {
    settings: defaultSettings,
    signal: new AbortController().signal,
    ...input,
  };
}

function history(...contents: string[]): InterviewMessage[] {
  return contents.map((content, index) => ({
    role: index % 2 ? "assistant" : "user",
    content,
    createdAt: `2026-08-28T00:0${index}:00.000Z`,
  }));
}

test("the first turn creates one system context and the second turn reuses its session", async () => {
  const sessions: FakeSession[] = [];
  const pool = new InterviewSessionPool({
    createSession: async ({ systemPrompt }) => {
      const session = new FakeSession(systemPrompt, "answer");
      sessions.push(session);
      return session;
    },
  });

  try {
    await pool.run(runInput({
      jobId: "job-a",
      systemPrompt: "context-a",
      prompt: "latest-a",
      rebuildPrompt: "history-a\nlatest-a",
    }));
    await pool.run(runInput({
      jobId: "job-a",
      systemPrompt: "context-a",
      prompt: "latest-b",
      rebuildPrompt: "history-b\nlatest-b",
    }));

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.systemPrompt, "context-a");
    assert.deepEqual(sessions[0]?.promptTexts, ["history-a\nlatest-a", "latest-b"]);
  } finally {
    await pool.close();
  }
});

test("a provider or model change rebuilds the job session", async () => {
  const sessions: FakeSession[] = [];
  const pool = new InterviewSessionPool({
    createSession: async ({ systemPrompt }) => {
      const session = new FakeSession(systemPrompt, "answer");
      sessions.push(session);
      return session;
    },
  });

  try {
    await pool.run(runInput({ jobId: "job-a", systemPrompt: "context-a", prompt: "first", rebuildPrompt: "history-first" }));
    await pool.run(runInput({
      jobId: "job-a",
      systemPrompt: "context-a",
      prompt: "second",
      rebuildPrompt: "history-second",
      settings: { ...defaultSettings, provider: "other-provider" },
    }));

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.disposed, true);
    assert.equal(sessions[1]?.promptTexts[0], "history-second");
  } finally {
    await pool.close();
  }
});

test("rebuild prompts preserve ordered user and assistant history", async () => {
  const sessions: FakeSession[] = [];
  const messages = history("user one", "assistant one", "user two", "assistant two");
  const rebuildPrompt = messages.map(({ role, content }) => `${role}:${content}`).join("|");
  const pool = new InterviewSessionPool({
    createSession: async ({ systemPrompt }) => {
      const session = new FakeSession(systemPrompt, "new answer");
      sessions.push(session);
      return session;
    },
  });

  try {
    await pool.run(runInput({
      jobId: "job-a",
      systemPrompt: "context-a",
      prompt: "latest",
      rebuildPrompt,
    }));
    assert.equal(sessions[0]?.promptTexts[0], "user:user one|assistant:assistant one|user:user two|assistant:assistant two");
  } finally {
    await pool.close();
  }
});

test("job sessions remain isolated", async () => {
  const sessions = new Map<string, FakeSession>();
  const pool = new InterviewSessionPool({
    createSession: async ({ jobId, systemPrompt }) => {
      const session = new FakeSession(systemPrompt, `answer-${jobId}`);
      sessions.set(jobId, session);
      return session;
    },
  });

  try {
    await pool.run(runInput({ jobId: "job-a", systemPrompt: "context-a", prompt: "a-turn", rebuildPrompt: "a-history\na-turn" }));
    await pool.run(runInput({ jobId: "job-b", systemPrompt: "context-b", prompt: "b-turn", rebuildPrompt: "b-history\nb-turn" }));

    assert.equal(sessions.size, 2);
    assert.equal(sessions.get("job-a")?.systemPrompt, "context-a");
    assert.equal(sessions.get("job-b")?.systemPrompt, "context-b");
    assert.equal(sessions.get("job-a")?.promptTexts.some((value) => value.includes("job-b")), false);
    assert.equal(sessions.get("job-b")?.promptTexts.some((value) => value.includes("job-a")), false);
  } finally {
    await pool.close();
  }
});

test("idle sessions expire and the next turn rebuilds", async () => {
  let now = 0;
  const sessions: FakeSession[] = [];
  const pool = new InterviewSessionPool({
    ttlMs: 50,
    sweepIntervalMs: 1_000,
    now: () => now,
    createSession: async ({ systemPrompt }) => {
      const session = new FakeSession(systemPrompt, "answer");
      sessions.push(session);
      return session;
    },
  });

  try {
    await pool.run(runInput({ jobId: "job-a", systemPrompt: "context-a", prompt: "first", rebuildPrompt: "history-first" }));
    now = 51;
    assert.equal(pool.pruneExpired(), 1);
    assert.equal(sessions[0]?.disposed, true);
    await pool.run(runInput({ jobId: "job-a", systemPrompt: "context-a", prompt: "second", rebuildPrompt: "history-second" }));
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1]?.promptTexts[0], "history-second");
  } finally {
    await pool.close();
  }
});

test("the TTL sweeper disposes an idle session without another turn", async () => {
  const sessions: FakeSession[] = [];
  const pool = new InterviewSessionPool({
    ttlMs: 20,
    createSession: async ({ systemPrompt }) => {
      const session = new FakeSession(systemPrompt, "answer");
      sessions.push(session);
      return session;
    },
  });

  await pool.run(runInput({ jobId: "job-a", systemPrompt: "context-a", prompt: "first", rebuildPrompt: "history-first" }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sessions[0]?.disposed, true);
    assert.equal(pool.size(), 0);
  } finally {
    await pool.close();
  }
});

test("LRU eviction removes the oldest idle job and never the active job", async () => {
  let now = 0;
  const sessions = new Map<string, FakeSession>();
  const pool = new InterviewSessionPool({
    maxEntries: 2,
    sweepIntervalMs: 1_000,
    now: () => now,
    createSession: async ({ jobId, systemPrompt }) => {
      const session = new FakeSession(systemPrompt, jobId === "job-a" ? "a" : jobId === "job-b" ? "b" : "c", jobId === "job-active" ? "hang" : "ok");
      sessions.set(jobId, session);
      return session;
    },
  });

  try {
    const controller = new AbortController();
    const active = pool.run(runInput({ jobId: "job-active", systemPrompt: "context-active", prompt: "active", rebuildPrompt: "active-history", signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    now = 1;
    await pool.run(runInput({ jobId: "job-b", systemPrompt: "context-b", prompt: "b", rebuildPrompt: "b-history" }));
    now = 2;
    await pool.run(runInput({ jobId: "job-c", systemPrompt: "context-c", prompt: "c", rebuildPrompt: "c-history" }));

    assert.equal(sessions.get("job-active")?.disposed, false);
    assert.equal(sessions.get("job-b")?.disposed, true);
    assert.equal(sessions.get("job-c")?.disposed, false);

    controller.abort();
    await assert.rejects(active, PiRunCancelledError);
  } finally {
    await pool.close();
  }
});

test("failed sessions are discarded and rebuilt from the durable history prompt", async () => {
  let creations = 0;
  const sessions: FakeSession[] = [];
  const pool = new InterviewSessionPool({
    createSession: async ({ systemPrompt }) => {
      const session = new FakeSession(systemPrompt, "answer", creations++ === 0 ? "fail" : "ok");
      sessions.push(session);
      return session;
    },
  });

  try {
    await assert.rejects(pool.run(runInput({
      jobId: "job-a",
      systemPrompt: "context-a",
      prompt: "latest",
      rebuildPrompt: "db:user one|assistant:answer one|latest",
    })), /provider failed/);
    assert.equal(sessions[0]?.disposed, true);
    assert.equal(pool.has("job-a"), false);

    await pool.run(runInput({
      jobId: "job-a",
      systemPrompt: "context-a",
      prompt: "latest again",
      rebuildPrompt: "db:user one|assistant:answer one|latest again",
    }));
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1]?.promptTexts[0], "db:user one|assistant:answer one|latest again");
  } finally {
    await pool.close();
  }
});

test("cancellation disposes the session and releases its pool entry", async () => {
  const controller = new AbortController();
  let session!: FakeSession;
  const pool = new InterviewSessionPool({
    createSession: async ({ systemPrompt }) => (session = new FakeSession(systemPrompt, "never", "hang")),
  });

  try {
    const run = pool.run(runInput({
      jobId: "job-a",
      systemPrompt: "context-a",
      prompt: "cancel me",
      rebuildPrompt: "cancel history",
      signal: controller.signal,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(run, PiRunCancelledError);
    assert.equal(session.abortCalls, 1);
    assert.equal(session.disposed, true);
    assert.equal(pool.has("job-a"), false);
  } finally {
    await pool.close();
  }
});

test("close clears pooled sessions and a new pool rebuilds from supplied history", async () => {
  const firstSessions: FakeSession[] = [];
  const firstPool = new InterviewSessionPool({
    createSession: async ({ systemPrompt }) => {
      const session = new FakeSession(systemPrompt, "answer");
      firstSessions.push(session);
      return session;
    },
  });
  await firstPool.run(runInput({ jobId: "job-a", systemPrompt: "context-a", prompt: "first", rebuildPrompt: "db-history" }));
  await firstPool.close();
  assert.equal(firstPool.size(), 0);
  assert.equal(firstSessions[0]?.disposed, true);

  const restartedSessions: FakeSession[] = [];
  const restartedPool = new InterviewSessionPool({
    createSession: async ({ systemPrompt }) => {
      const session = new FakeSession(systemPrompt, "answer after restart");
      restartedSessions.push(session);
      return session;
    },
  });
  try {
    await restartedPool.run(runInput({ jobId: "job-a", systemPrompt: "context-a", prompt: "after restart", rebuildPrompt: "db-history" }));
    assert.equal(restartedSessions.length, 1);
    assert.equal(restartedSessions[0]?.promptTexts[0], "db-history");
  } finally {
    await restartedPool.close();
  }
});
