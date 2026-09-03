import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  classifyPiError,
  PiRunCancelledError,
  PiRunTimeoutError,
  runBoundedPi,
  selectConfiguredModel,
  type PiSessionLike,
  type PiPromptOptions,
} from "../src/server/pi.js";

const priorTelemetryMode = process.env.TELEMETRY_MODE;
process.env.TELEMETRY_MODE = "redacted";
test.after(() => {
  if (priorTelemetryMode === undefined) delete process.env.TELEMETRY_MODE;
  else process.env.TELEMETRY_MODE = priorTelemetryMode;
});

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
  promptOptions: PiPromptOptions | undefined;
  private readonly listeners = new Set<(event: unknown) => void>();
  private lateReject: ((reason: Error) => void) | undefined;
  constructor(
    private readonly behavior: "ok" | "hang" | "late-reject" | "fail" = "ok",
    private readonly events: unknown[] = [],
    private readonly failure = new Error("provider failed"),
  ) {}
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribed = true;
      this.listeners.delete(listener);
    };
  }
  async prompt(text: string, options?: PiPromptOptions): Promise<void> {
    this.promptText = text;
    this.promptOptions = options;
    for (const event of this.events) {
      for (const listener of this.listeners) listener(event);
    }
    if (this.behavior === "hang") await new Promise<void>(() => {});
    if (this.behavior === "late-reject") {
      await new Promise<void>((_resolve, reject) => {
        this.lateReject = reject;
      });
      return;
    }
    if (this.behavior === "fail") throw this.failure;
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

test("Pi forwards image attachments to session.prompt", async () => {
  let session!: FakeSession;
  const images = [{ type: "image" as const, data: "cG5n", mimeType: "image/png" }];
  await runBoundedPi({
    prompt: "inspect these pages",
    images,
    timeoutMs: 1000,
    createSession: async () => (session = new FakeSession("ok")),
  });
  assert.deepEqual(session.promptOptions?.images, images);
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

test("Pi heartbeat calls onActivity and aborts an inactive session", async () => {
  let session!: FakeSession;
  let activityCount = 0;
  await assert.rejects(
    runBoundedPi({
      prompt: "heartbeat",
      timeoutMs: 1_000,
      inactivityTimeoutMs: 30,
      onActivity: () => { activityCount += 1; },
      createSession: async () => (session = new FakeSession("hang", [{ type: "agent_start" }])),
    }),
    PiRunTimeoutError,
  );
  assert.equal(session.abortCalls, 1);
  assert.ok(activityCount >= 1);
});

test("Pi timeout records exactly one terminal lifecycle event", async () => {
  const trajectory: Array<{ type: string; payload?: unknown }> = [];
  await assert.rejects(
    runBoundedPi({
      prompt: "timeout lifecycle",
      timeoutMs: 1_000,
      inactivityTimeoutMs: 30,
      runId: "timeout-lifecycle",
      trajectory: (_runId, event) => { trajectory.push(event); },
      createSession: async () => new FakeSession("hang", [{ type: "agent_start" }]),
    }),
    PiRunTimeoutError,
  );
  const terminal = trajectory.filter(({ type }) => ["run_timed_out", "run_cancelled", "run_failed", "run_completed"].includes(type));
  assert.deepEqual(terminal.map(({ type }) => type), ["run_timed_out"]);
});

test("Pi flushes open tool state on success, failure, timeout, and cancellation", async () => {
  const toolStart = { type: "tool_execution_start", toolCallId: "call-1", toolName: "lookupJob", args: { id: "job-1" } };
  const cases = [
    { behavior: "ok" as const, expectedError: undefined },
    { behavior: "fail" as const, expectedError: new Error("provider failed") },
    { behavior: "hang" as const, expectedError: new PiRunTimeoutError() },
    { behavior: "hang" as const, expectedError: new PiRunCancelledError() },
  ];
  for (const [index, current] of cases.entries()) {
    const trajectory: Array<{ type: string; payload?: unknown }> = [];
    const controller = new AbortController();
    const run = runBoundedPi({
      prompt: `tool ${index}`,
      timeoutMs: 1_000,
      inactivityTimeoutMs: current.behavior === "hang" ? 30 : 1_000,
      signal: index === 3 ? controller.signal : undefined,
      runId: `tool-${index}`,
      trajectory: (_runId, event) => { trajectory.push(event); },
      createSession: async () => new FakeSession(current.behavior, [toolStart], current.expectedError),
    });
    if (index === 3) controller.abort();
    if (current.expectedError) await assert.rejects(run);
    else await run;
    assert.ok(trajectory.some(({ type }) => type === "tool_execution_start"));
    assert.ok(trajectory.some(({ type }) => type === "tool_execution_end"));
  }
});

test("Pi flushes assistant state on message_end, agent_end, and failure", async () => {
  const message = { role: "assistant", timestamp: 7, content: [{ type: "text", text: "Answer" }] };
  const cases = [
    { behavior: "ok" as const, events: [{ type: "message_end", message }] },
    { behavior: "ok" as const, events: [{ type: "agent_end", messages: [message] }] },
    { behavior: "fail" as const, events: [{ type: "message_update", message: { ...message, content: [] }, assistantMessageEvent: { type: "text_delta", delta: "Answer" } }] },
  ];
  for (const [index, current] of cases.entries()) {
    const trajectory: Array<{ type: string; payload?: unknown }> = [];
    await (current.behavior === "fail"
      ? assert.rejects(runBoundedPi({
        prompt: `assistant ${index}`,
        timeoutMs: 1_000,
        runId: `assistant-${index}`,
        trajectory: (_runId, event) => { trajectory.push(event); },
        createSession: async () => new FakeSession(current.behavior, current.events),
      }))
      : runBoundedPi({
        prompt: `assistant ${index}`,
        timeoutMs: 1_000,
        runId: `assistant-${index}`,
        trajectory: (_runId, event) => { trajectory.push(event); },
        createSession: async () => new FakeSession(current.behavior, current.events),
      }));
    assert.equal(trajectory.filter(({ type }) => type === "assistant_message").length, 1);
    assert.equal((trajectory.find(({ type }) => type === "assistant_message")?.payload as { text?: string } | undefined)?.text, "Answer");
  }
});

test("Pi extracts provider usage and leaves missing usage null", async () => {
  const usage = {
    input: 3,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  };
  const received: unknown[] = [];
  await runBoundedPi({
    prompt: "usage",
    timeoutMs: 1_000,
    onUsage: value => { received.push(value); },
    createSession: async () => new FakeSession("ok", [{
      type: "message_end",
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Done" }], usage },
    }]),
  });
  assert.deepEqual(received, [{ inputTokens: 3, outputTokens: 5, totalTokens: 8, estimatedCost: 0.3 }]);

  const missingTrajectory: Array<{ type: string; payload?: unknown }> = [];
  const missingUsage: unknown[] = [];
  await runBoundedPi({
    prompt: "missing usage",
    timeoutMs: 1_000,
    onUsage: value => { missingUsage.push(value); },
    runId: "missing-usage",
    trajectory: (_runId, event) => { missingTrajectory.push(event); },
    createSession: async () => new FakeSession("ok", [{
      type: "message_end",
      message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Done" }] },
    }]),
  });
  assert.deepEqual(missingUsage, []);
  assert.deepEqual((missingTrajectory.find(({ type }) => type === "assistant_message")?.payload as { usage?: unknown } | undefined)?.usage, null);
});

test("Pi classifies bounded and provider errors without confusing rejection with cancellation", () => {
  assert.equal(classifyPiError(new PiRunTimeoutError()), "timeout");
  assert.equal(classifyPiError(new PiRunCancelledError()), "cancelled");
  assert.equal(classifyPiError(new Error("rate limit exceeded")), "rate_limit");
  assert.equal(classifyPiError(new Error("HTTP 429")), "rate_limit");
  assert.equal(classifyPiError(new Error("ECONNRESET while requesting provider")), "network");
  assert.equal(classifyPiError(new Error("fetch failed")), "network");
  assert.equal(classifyPiError(new Error("ENOTFOUND api.example.test")), "network");
  assert.equal(classifyPiError(new Error("context length overflow")), "context_overflow");
  assert.equal(classifyPiError(new Error("empty response")), "empty_response");
  assert.equal(classifyPiError(new Error("provider rejected request")), "provider");
  assert.equal(classifyPiError("not an Error"), "unknown");
});

test("Pi records context hashes while keeping secrets out of trajectory payloads", async () => {
  const prompt = "Use this token sk-testsecret only as untrusted text.";
  const trajectory: Array<{ type: string; payload?: unknown }> = [];
  await runBoundedPi({
    prompt,
    guidance: "Use grounded facts.",
    settings: { provider: "fixture", model: "test" },
    model: { provider: "fixture", id: "test-model" },
    timeoutMs: 1_000,
    runId: "context-hashes",
    trajectory: (_runId, event) => { trajectory.push(event); },
    createSession: async () => new FakeSession("ok"),
  });
  const context = trajectory.find(({ type }) => type === "run_context")?.payload as {
    promptHash?: string;
    guidanceHash?: string;
    settingsHash?: string;
    modelHash?: string;
  } | undefined;
  assert.equal(context?.promptHash, createHash("sha256").update(prompt).digest("hex"));
  assert.match(context?.guidanceHash ?? "", /^[0-9a-f]{64}$/);
  assert.match(context?.settingsHash ?? "", /^[0-9a-f]{64}$/);
  assert.match(context?.modelHash ?? "", /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(trajectory), /sk-testsecret/);
});

test("Pi keeps telemetry text capped", async () => {
  const trajectory: Array<{ type: string; payload?: unknown }> = [];
  await runBoundedPi({
    prompt: "x".repeat(2_000_010),
    timeoutMs: 1_000,
    runId: "telemetry-cap",
    trajectory: (_runId, event) => { trajectory.push(event); },
    createSession: async () => new FakeSession("ok"),
  });
  const text = (trajectory.find(({ type }) => type === "user_prompt")?.payload as { text?: string } | undefined)?.text;
  assert.equal(text?.length, 2_000_000);
});
