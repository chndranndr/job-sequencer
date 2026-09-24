import test from "node:test";
import assert from "node:assert/strict";
import { createSdkMcpServer, tool } from "@qoder-ai/qoder-agent-sdk";
import { z } from "zod";
import { QoderSession, type QoderSessionOptions } from "../src/server/qoder.js";
import {
  fauxTransportProvider,
  fauxInitFrame,
  fauxAssistantFrame,
  fauxToolResultFrame,
  fauxDeltaFrame,
  fauxThinkingDeltaFrame,
  fauxContentBlockStopFrame,
  fauxMessageStartFrame,
  fauxResultFrame,
  waitFor,
  type FauxRecorder,
  type WireFrame,
} from "../src/server/testing/qoder-faux.js";

type Captured = { type?: string; [key: string]: unknown };

function startSession(options: Pick<QoderSessionOptions, "mcpServers" | "mcpTools"> = {}) {
  const recorder: FauxRecorder = {};
  const session = new QoderSession({
    auth: { type: "qodercli" },
    transport: fauxTransportProvider(recorder),
    controlRequestTimeoutMs: 250,
    ...options,
  });
  const events: Captured[] = [];
  session.subscribe((event) => events.push(event as Captured));
  return { session, recorder, events };
}

async function transportOf(recorder: FauxRecorder) {
  return await waitFor(() => recorder.transport, { label: "transport create" });
}

test("1: query launch options pin the tool boundary", async () => {
  const { session, recorder } = startSession();
  const launch = (await waitFor(() => recorder.createOptions, { label: "launch options" })) as Record<string, unknown>;
  assert.deepEqual(launch.tools, [], "tools:[] sent explicitly");
  const disallowed = launch.disallowedTools as string[];
  for (const builtin of ["Bash", "Read", "Edit", "Write"]) assert.ok(disallowed.includes(builtin), `${builtin} disallowed`);
  assert.equal(launch.persistSession, false);
  assert.deepEqual(launch.settingSources, []);
  assert.equal(launch.includePartialMessages, true);
  assert.equal(launch.permissionMode, "default");
  assert.equal(launch.allowDangerouslySkipPermissions, undefined, "no bypass flag ever set");
  assert.equal(launch.canUseTool, true, "canUseTool presence flag rides launch options; the callback stays in-process");
  session.dispose();
});

test("2: text deltas stream as timestamp-grouped message_update events and prompt resolves on result", async () => {
  const { session, recorder, events } = startSession();
  const t = await transportOf(recorder);
  const prompt = session.prompt("synthetic");
  t.push(fauxInitFrame({ tools: [] }));
  t.push(fauxMessageStartFrame());
  t.push(fauxDeltaFrame("Hello "));
  t.push(fauxDeltaFrame("world"));
  t.push(fauxContentBlockStopFrame());
  t.push(fauxAssistantFrame({ text: "Hello world", usage: { input_tokens: 11, output_tokens: 7 } }));
  t.push(fauxResultFrame({ subtype: "success", result: "Hello world" }));
  await prompt;

  const deltas = events.filter((e) => e.type === "message_update" && (e.assistantMessageEvent as Captured)?.type === "text_delta");
  assert.deepEqual(deltas.map((d) => (d.assistantMessageEvent as Captured).delta), ["Hello ", "world"]);
  const textEnd = events.find((e) => (e.assistantMessageEvent as Captured)?.type === "text_end");
  assert.equal((textEnd?.assistantMessageEvent as Captured).content, "Hello world", "text_end carries accumulated content");

  const messageEnd = events.find((e) => e.type === "message_end");
  const message = messageEnd?.message as Record<string, unknown>;
  const usage = message.usage as Record<string, unknown>;
  assert.equal(usage.input, 11);
  assert.equal(usage.output, 7);
  assert.equal(usage.totalTokens, 18);
  assert.equal(usage.cost, null, "credits are never folded into cost");

  const stamps = events
    .filter((e) => e.type === "message_update" || e.type === "message_start" || e.type === "message_end")
    .map((e) => (e.message as Record<string, unknown>).timestamp);
  assert.equal(new Set(stamps).size, 1, "all events for one assistant message share a timestamp key");
  session.dispose();
});

test("3: thinking deltas translate to thinking_delta/thinking_end", async () => {
  const { session, recorder, events } = startSession();
  const t = await transportOf(recorder);
  const prompt = session.prompt("synthetic");
  t.push(fauxInitFrame());
  t.push(fauxMessageStartFrame());
  t.push(fauxThinkingDeltaFrame("let me think"));
  t.push(fauxContentBlockStopFrame());
  t.push(fauxAssistantFrame({ text: "answer" }));
  t.push(fauxResultFrame());
  await prompt;
  const thinkingDelta = events.find((e) => (e.assistantMessageEvent as Captured)?.type === "thinking_delta");
  assert.equal((thinkingDelta?.assistantMessageEvent as Captured).delta, "let me think");
  const thinkingEnd = events.find((e) => (e.assistantMessageEvent as Captured)?.type === "thinking_end");
  assert.equal((thinkingEnd?.assistantMessageEvent as Captured).content, "let me think");
  session.dispose();
});

test("4: tool_use and tool_result frames become tool_execution_start/end", async () => {
  const { session, recorder, events } = startSession();
  const t = await transportOf(recorder);
  const prompt = session.prompt("synthetic");
  t.push(fauxInitFrame());
  t.push(fauxAssistantFrame({ toolUse: [{ id: "tu-1", name: "searchJobs", input: { query: "backend" } }] }));
  t.push(fauxToolResultFrame("tu-1", { content: [{ type: "text", text: "{}" }] }));
  t.push(fauxResultFrame());
  await prompt;
  const start = events.find((e) => e.type === "tool_execution_start");
  assert.equal(start?.toolCallId, "tu-1");
  assert.equal(start?.toolName, "searchJobs");
  assert.deepEqual(start?.args, { query: "backend" });
  const end = events.find((e) => e.type === "tool_execution_end");
  assert.equal(end?.toolCallId, "tu-1");
  assert.equal(end?.toolName, "searchJobs");
  assert.equal(end?.isError, false);
  session.dispose();
});

test("5: error result subtype rejects prompt with the subtype in the message", async () => {
  const { session, recorder } = startSession();
  const t = await transportOf(recorder);
  const prompt = session.prompt("synthetic");
  t.push(fauxInitFrame());
  t.push(fauxResultFrame({ subtype: "error_during_execution", errors: ["synthetic model failure"] }));
  await assert.rejects(prompt, /error_during_execution.*synthetic model failure/);
  session.dispose();
});

test("6: abort settles a pending prompt without throwing to the consumer and closes the transport", async () => {
  const { session, recorder } = startSession();
  const t = await transportOf(recorder);
  const prompt = session.prompt("synthetic");
  t.push(fauxInitFrame());
  await session.abort();
  await prompt;
  assert.equal(t.closed, true, "transport closed after abort");
  await session.abort();
  session.dispose();
});

test("7: multi-turn reuses one query — one initialize, two user messages", async () => {
  const { session, recorder } = startSession();
  const t = await transportOf(recorder);
  const first = session.prompt("turn one");
  t.push(fauxInitFrame());
  t.push(fauxResultFrame());
  await first;
  const second = session.prompt("turn two");
  t.push(fauxResultFrame());
  await second;
  const initializes = t.written.filter((line) => line.type === "control_request" && (line.request as WireFrame)?.type === "initialize");
  assert.equal(initializes.length, 1, "single initialize across turns");
  const userMessages = t.written.filter((line) => line.type === "user");
  assert.equal(userMessages.length, 2, "one user message per prompt");
  session.dispose();
});

test("8: images are sent as base64 image blocks", async () => {
  const { session, recorder } = startSession();
  const t = await transportOf(recorder);
  const prompt = session.prompt("describe", { images: [{ type: "image", data: "aGk=", mimeType: "image/png" }] });
  t.push(fauxInitFrame());
  const userLine = await t.waitForWritten((line) => line.type === "user", { label: "user message with image" });
  const content = ((userLine.message as Record<string, unknown>).content as Array<Record<string, unknown>>);
  const imageBlock = content.find((block) => block.type === "image");
  assert.ok(imageBlock, "image block present");
  assert.deepEqual(imageBlock?.source, { type: "base64", media_type: "image/png", data: "aGk=" });
  t.push(fauxResultFrame());
  await prompt;
  session.dispose();
});

test("9: canUseTool denies builtins and allows registered MCP tools", async () => {
  const server = createSdkMcpServer({
    name: "search",
    tools: [tool("searchJobs", "synthetic", { query: z.string() }, async () => ({ content: [{ type: "text", text: "{}" }] }))],
  });
  const { session, recorder } = startSession({ mcpServers: { search: server }, mcpTools: { search: ["searchJobs"] } });
  const t = await transportOf(recorder);
  t.push(fauxInitFrame());
  await waitFor(() => recorder.createOptions, { label: "launch options" });

  const denyResponse = await t.requestFromCli({ subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: "tu-bash" });
  assert.equal(denyResponse.subtype, "success");
  assert.equal((denyResponse.response as Record<string, unknown>).behavior, "deny");

  const allowResponse = await t.requestFromCli({ subtype: "can_use_tool", tool_name: "mcp__search__searchJobs", input: { query: "x" }, tool_use_id: "tu-mcp" });
  assert.equal((allowResponse.response as Record<string, unknown>).behavior, "allow");
  session.dispose();
});

test("10: MCP tools/list through the adapter returns exactly the registered tool", async () => {
  const server = createSdkMcpServer({
    name: "search",
    tools: [tool("searchJobs", "synthetic", { query: z.string() }, async () => ({ content: [{ type: "text", text: "{}" }] }))],
  });
  const { session, recorder } = startSession({ mcpServers: { search: server } });
  const t = await transportOf(recorder);
  t.push(fauxInitFrame());
  const listResponse = await t.requestFromCli({ subtype: "mcp_message", server_name: "search", message: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
  const rpc = (listResponse.response as Record<string, unknown>).mcp_response as Record<string, unknown>;
  const tools = ((rpc.result as Record<string, unknown>).tools as Array<{ name: string }>);
  assert.deepEqual(tools.map((entry) => entry.name), ["searchJobs"]);
  session.dispose();
});

test("11: getActiveToolNames reflects the init frame tools after ready()", async () => {
  const recorder: FauxRecorder = {};
  const session = new QoderSession({ auth: { type: "qodercli" }, transport: fauxTransportProvider(recorder) });
  const t = await waitFor(() => recorder.transport, { label: "transport" });
  const ready = session.ready(2_000);
  t.push(fauxInitFrame({ tools: ["mcp__search__searchJobs"] }));
  await ready;
  assert.deepEqual(session.getActiveToolNames(), ["mcp__search__searchJobs"]);
  assert.deepEqual(session.getAllTools(), [{ name: "mcp__search__searchJobs" }]);
  session.dispose();
});

test("12: concurrent prompt rejects busy; prompt after dispose rejects", async () => {
  const { session, recorder } = startSession();
  const t = await transportOf(recorder);
  const first = session.prompt("one");
  await assert.rejects(session.prompt("two"), /busy/);
  t.push(fauxInitFrame());
  t.push(fauxResultFrame());
  await first;
  session.dispose();
  await assert.rejects(session.prompt("three"), /disposed/);
});

test("13: abort mid-stream settles the pending prompt after deltas and closes the transport", async () => {
  const { session, recorder, events } = startSession();
  const t = await transportOf(recorder);
  const prompt = session.prompt("synthetic");
  t.push(fauxInitFrame());
  t.push(fauxMessageStartFrame());
  t.push(fauxDeltaFrame("partial answer"));
  await waitFor(() => events.some((event) => event.type === "message_update"), { label: "delta event" });
  await session.abort();
  await prompt;
  assert.equal(t.closed, true, "transport closed after mid-stream abort");
  assert.equal(events.some((event) => event.type === "message_update"), true, "deltas emitted before cancel are kept");
  session.dispose();
});

test("14: abort while a tool handler is active aborts the handler signal and closes the transport", async () => {
  let handlerStarted = false;
  let handlerAborted = false;
  const slow = tool("slowSearch", "synthetic", { query: z.string() }, async (_args, extra) => {
    handlerStarted = true;
    return await new Promise((resolve) => {
      const signal = extra?.signal as AbortSignal | undefined;
      if (!signal) { resolve({ content: [{ type: "text", text: "no signal" }], isError: true }); return; }
      signal.addEventListener("abort", () => {
        handlerAborted = true;
        resolve({ content: [{ type: "text", text: "cancelled" }], isError: true });
      }, { once: true });
    });
  });
  const server = createSdkMcpServer({ name: "search", tools: [slow] });
  const { session, recorder } = startSession({ mcpServers: { search: server } });
  const t = await transportOf(recorder);
  t.push(fauxInitFrame());
  const call = t.requestFromCli({ subtype: "mcp_message", server_name: "search", message: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slowSearch", arguments: { query: "x" } } } });
  await waitFor(() => handlerStarted, { label: "tool handler start" });
  await session.abort();
  await waitFor(() => handlerAborted, { label: "handler signal abort" });
  void call.catch(() => {});
  assert.equal(t.closed, true, "transport closed after mid-handler abort");
  session.dispose();
});
