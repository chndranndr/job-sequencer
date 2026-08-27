import test from "node:test";
import assert from "node:assert/strict";
import { runBoundedPi, selectConfiguredModel, type PiSessionLike, PiRunCancelledError, PiRunTimeoutError } from "../src/server/pi.js";

test("configured OpenAI Codex provider is passed to the Pi model registry", () => {
  const calls: string[][] = [];
  const model = selectConfiguredModel({
    getModel: (provider, id) => { calls.push([provider, id]); return { provider, id }; },
    getModels: (provider) => { calls.push([provider, "default"]); return []; },
  }, { provider: "openai-codex", model: "gpt-5.6-luna" });
  assert.deepEqual(model, { provider: "openai-codex", id: "gpt-5.6-luna" });
  assert.deepEqual(calls, [["openai-codex", "gpt-5.6-luna"]]);
});

class FakeSession implements PiSessionLike {
  disposed = false;
  unsubscribed = false;
  abortCalls = 0;
  promptText = "";
  private readonly listeners = new Set<(event: unknown) => void>();
  private lateReject: ((reason: Error) => void) | undefined;
  constructor(
    private readonly behavior: "ok" | "hang" | "late-reject" = "ok",
    private readonly events: unknown[] = [],
  ) {}
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribed = true;
      this.listeners.delete(listener);
    };
  }
  async prompt(text: string): Promise<void> {
    this.promptText = text;
    if (this.behavior === "hang") await new Promise<void>(() => {});
    if (this.behavior === "late-reject") {
      await new Promise<void>((_resolve, reject) => {
        this.lateReject = reject;
      });
      return;
    }
    for (const event of this.events) {
      for (const listener of this.listeners) listener(event);
    }
  }
  async abort(): Promise<void> {
    this.abortCalls += 1;
    const reject = this.lateReject;
    this.lateReject = undefined;
    if (reject) setTimeout(() => reject(new Error("late prompt reject")), 0);
  }
  dispose(): void { this.disposed = true; }
}

test("Pi timeout aborts, unsubscribes, and disposes", async () => {
  let session!: FakeSession;
  await assert.rejects(
    runBoundedPi({
      prompt: "hang",
      timeoutMs: 20,
      createSession: async () => (session = new FakeSession("hang")),
    }),
    PiRunTimeoutError,
  );
  assert.equal(session.abortCalls, 1);
  assert.equal(session.unsubscribed, true);
  assert.equal(session.disposed, true);
});

test("Pi cancellation aborts, unsubscribes, and disposes", async () => {
  let session!: FakeSession;
  const controller = new AbortController();
  const run = runBoundedPi({
    prompt: "cancel",
    timeoutMs: 1000,
    signal: controller.signal,
    createSession: async () => (session = new FakeSession("hang")),
  });
  controller.abort();
  await assert.rejects(run, PiRunCancelledError);
  assert.equal(session.abortCalls, 1);
  assert.equal(session.unsubscribed, true);
  assert.equal(session.disposed, true);
});

test("Pi prompt errors still unsubscribe and dispose", async () => {
  let unsubscribed = false;
  let disposed = false;
  const failingSession: PiSessionLike = {
    subscribe: () => () => { unsubscribed = true; },
    prompt: async () => { throw new Error("provider failed"); },
    abort: async () => {},
    dispose: () => { disposed = true; },
  };
  await assert.rejects(
    runBoundedPi({ prompt: "error", timeoutMs: 1000, createSession: async () => failingSession }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "provider failed");
      assert.equal(error instanceof PiRunCancelledError, false);
      assert.equal(error instanceof PiRunTimeoutError, false);
      return true;
    },
  );
  assert.equal(unsubscribed, true);
  assert.equal(disposed, true);
});

test("Pi session.prompt receives the expected prompt string", async () => {
  let session!: FakeSession;
  await runBoundedPi({
    prompt: "expected prompt",
    timeoutMs: 1000,
    createSession: async () => (session = new FakeSession("ok")),
  });
  assert.equal(session.promptText, "expected prompt");
});

test("text_delta events are forwarded via onEvent and accumulated", async () => {
  const hel = {
    type: "message_update",
    message: { role: "assistant", timestamp: 1, content: [] },
    assistantMessageEvent: { type: "text_delta", delta: "Hel" },
  };
  const lo = {
    type: "message_update",
    message: { role: "assistant", timestamp: 1, content: [] },
    assistantMessageEvent: { type: "text_delta", delta: "lo" },
  };
  const forwarded: unknown[] = [];
  const trajectory: Array<{ type: string; payload?: unknown }> = [];
  await runBoundedPi({
    prompt: "hello",
    timeoutMs: 1000,
    runId: "text-delta",
    trajectory: (_runId, event) => { trajectory.push(event); },
    onEvent: (event) => { forwarded.push(event); },
    createSession: async () => new FakeSession("ok", [hel, lo]),
  });
  assert.deepEqual(forwarded, [hel, lo]);
  const assistant = trajectory.filter((event) => event.type === "assistant_message");
  assert.equal(assistant.length, 1);
  assert.equal((assistant[0]?.payload as { text?: string } | undefined)?.text, "Hello");
});

test("thinking_delta events are recorded via onEvent", async () => {
  const thinking = {
    type: "message_update",
    message: { role: "assistant", timestamp: 1, content: [] },
    assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
  };
  const forwarded: unknown[] = [];
  await runBoundedPi({
    prompt: "think",
    timeoutMs: 1000,
    onEvent: (event) => { forwarded.push(event); },
    createSession: async () => new FakeSession("ok", [thinking]),
  });
  assert.deepEqual(forwarded, [thinking]);
});

test("Pi successful prompt still unsubscribes and disposes", async () => {
  let session!: FakeSession;
  await runBoundedPi({
    prompt: "ok",
    timeoutMs: 1000,
    createSession: async () => (session = new FakeSession("ok")),
  });
  assert.equal(session.disposed, true);
  assert.equal(session.unsubscribed, true);
  assert.equal(session.abortCalls, 0);
});

test("unknown or malformed events do not crash the run", async () => {
  const malformed = [
    null,
    { type: 123 },
    { no: "type" },
    { type: "message_update", message: "weird", assistantMessageEvent: { nested: { type: "text_delta" } } },
  ];
  await runBoundedPi({
    prompt: "malformed",
    timeoutMs: 1000,
    createSession: async () => new FakeSession("ok", malformed),
  });
});

test("losing prompt rejection after timeout is not unhandled", async () => {
  let session!: FakeSession;
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => { unhandled = reason; };
  process.once("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      runBoundedPi({
        prompt: "hang",
        timeoutMs: 20,
        createSession: async () => (session = new FakeSession("late-reject")),
      }),
      PiRunTimeoutError,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled, undefined);
    assert.equal(session.abortCalls, 1);
    assert.equal(session.disposed, true);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
