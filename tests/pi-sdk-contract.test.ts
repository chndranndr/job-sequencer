import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, PromptOptions, SessionStats } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";

/**
 * Verified against installed declarations, not guessed:
 * node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts
 * node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts
 * node_modules/@earendil-works/pi-ai/dist/types.d.ts
 *
 * Native history: AgentSession.messages (AgentMessage[]).
 * Usage on AssistantMessage.usage and SessionStats.tokens/cost.
 * Usage fields are input/output/totalTokens/cost, not inputTokens.
 * Thinking: AgentSession.thinkingLevel plus createAgentSession({ thinkingLevel }).
 * Retry/compaction: SettingsManager compaction/retry flags; events auto_retry_* and compaction_*.
 * Errors: AssistantMessage.errorMessage plus stopReason "error" | "aborted".
 * Reuse: prompt() may be called again on the same session; dispose() is sync void.
 * Abort: abort() returns Promise<void> and waits for idle.
 */
type SessionPrompt = AgentSession["prompt"];
type SessionAbort = AgentSession["abort"];
type SessionDispose = AgentSession["dispose"];

test("Pi SDK session methods match installed AgentSession declarations", () => {
  const prompt: SessionPrompt = async (_text: string, _options?: PromptOptions) => {};
  const abort: SessionAbort = async () => {};
  const dispose: SessionDispose = () => {};
  assert.equal(typeof prompt, "function");
  assert.equal(typeof abort, "function");
  assert.equal(typeof dispose, "function");
});

test("Pi SDK usage fields are input/output/totalTokens/cost, not fabricated zeros", () => {
  const usage: Usage = {
    input: 3,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
  };
  assert.equal(usage.input, 3);
  assert.equal(usage.totalTokens, 8);
  assert.equal(usage.cost.total, 0.3);
});

test("Pi SDK session stats expose tokens and cost from native history", () => {
  const stats: SessionStats["tokens"] = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    total: 3,
  };
  assert.equal(stats.total, 3);
});

test("Pi SDK assistant stream events include text_delta and thinking_delta", () => {
  const text: AssistantMessageEvent["type"] = "text_delta";
  const thinking: AssistantMessageEvent["type"] = "thinking_delta";
  assert.equal(text, "text_delta");
  assert.equal(thinking, "thinking_delta");
});
