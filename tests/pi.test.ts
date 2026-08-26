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
  constructor(private readonly behavior: "ok" | "hang") {}
  subscribe(): () => void {
    return () => { this.unsubscribed = true; };
  }
  async prompt(): Promise<void> {
    if (this.behavior === "hang") await new Promise<void>(() => {});
  }
  async abort(): Promise<void> { this.abortCalls += 1; }
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
    /provider failed/,
  );
  assert.equal(unsubscribed, true);
  assert.equal(disposed, true);
});
