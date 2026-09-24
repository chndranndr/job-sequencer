import test from "node:test";
import assert from "node:assert/strict";
import type {
  Options,
  Query,
  CanUseTool,
  PermissionResult,
  ModelInfo,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@qoder-ai/qoder-agent-sdk";

/**
 * Contract pins for @qoder-ai/qoder-agent-sdk 1.0.49 — the exact declaration
 * surface src/server/qoder.ts depends on. Replaces tests/pi-sdk-contract.test.ts
 * at cutover. Compile-time is the assertion: a breaking SDK change fails tsc,
 * not runtime. Verified against installed dist/*.d.ts, not guessed.
 *
 * Wire facts proven live in spike/qoder-sdk (issue #24): system/init carries
 * tools:string[] and protocol_version; result subtypes gate success vs failure;
 * ModelInfo.source distinguishes catalog ("system") from BYOK ("user"/"custom").
 */

test("Qoder result subtypes include the four the adapter branches on", () => {
  const success: Extract<SDKResultMessage, { subtype: "success" }>["subtype"] = "success";
  const errorDuring: SDKResultMessage["subtype"] = "error_during_execution";
  const maxTurns: SDKResultMessage["subtype"] = "error_max_turns";
  const maxBudget: SDKResultMessage["subtype"] = "error_max_budget_usd";
  assert.equal(success, "success");
  assert.deepEqual([errorDuring, maxTurns, maxBudget], ["error_during_execution", "error_max_turns", "error_max_budget_usd"]);
});

test("Qoder system init message exposes the tool list the adapter caches", () => {
  const init: Extract<SDKSystemMessage, { subtype: "init" }> = {
    type: "system",
    subtype: "init",
    apiKeySource: "user",
    qodercli_version: "1.1.62",
    cwd: process.cwd(),
    tools: ["mcp__search__searchJobs"],
    mcp_servers: [],
    model: "faux",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "init",
    session_id: "s",
  };
  const tools: string[] = init.tools;
  assert.deepEqual(tools, ["mcp__search__searchJobs"]);
});

test("Qoder CanUseTool resolves to a PermissionResult allow/deny union", () => {
  const canUseTool: CanUseTool = async (toolName, _input, _options) =>
    toolName === "Bash"
      ? { behavior: "deny", message: "shell tools are out of product bounds" }
      : { behavior: "allow" };
  const deny: PermissionResult = { behavior: "deny", message: "no" };
  const allow: PermissionResult = { behavior: "allow" };
  assert.equal(typeof canUseTool, "function");
  assert.equal(deny.behavior, "deny");
  assert.equal(allow.behavior, "allow");
});

test("Qoder ModelInfo.source distinguishes catalog from BYOK custom models", () => {
  const system: ModelInfo = { value: "auto", displayName: "Auto", description: "", source: "system" };
  const user: ModelInfo = { value: "bailian-intl/qwen3.8-max-pg", displayName: "Qwen", description: "", source: "user" };
  assert.equal(system.source, "system");
  assert.equal(user.source, "user");
});

test("Qoder Options accepts every field the adapter pins", () => {
  const options: Options = {
    tools: [],
    disallowedTools: ["Bash", "Read", "Edit", "Write"],
    permissionMode: "default",
    persistSession: false,
    settingSources: [],
    includePartialMessages: true,
    controlRequestTimeoutMs: 30_000,
    auth: { type: "qodercli" },
    canUseTool: async () => ({ behavior: "deny", message: "closed" }),
  };
  assert.deepEqual(options.tools, []);
  assert.equal(options.persistSession, false);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.includePartialMessages, true);
});

test("Qoder Query exposes the lifecycle methods the adapter calls", () => {
  type Interrupt = Query["interrupt"];
  type Close = Query["close"];
  type Models = Query["getAvailableModels"];
  type Init = Query["initializationResult"];
  const interrupt = (async () => ({ still_queued: [] })) as Interrupt;
  const close = (async () => {}) as Close;
  const getAvailableModels = (async () => []) as Models;
  const initializationResult = (async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} })) as Init;
  assert.equal(typeof interrupt, "function");
  assert.equal(typeof close, "function");
  assert.equal(typeof getAvailableModels, "function");
  assert.equal(typeof initializationResult, "function");
});

test("Qoder SDKMessage union includes the frames the adapter translates", () => {
  const assistant: Extract<SDKMessage, { type: "assistant" }>["type"] = "assistant";
  const stream: Extract<SDKMessage, { type: "stream_event" }>["type"] = "stream_event";
  const result: Extract<SDKMessage, { type: "result" }>["type"] = "result";
  assert.equal(assistant, "assistant");
  assert.equal(stream, "stream_event");
  assert.equal(result, "result");
});
