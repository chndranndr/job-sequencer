import test from "node:test";
import assert from "node:assert/strict";
import { statSync, existsSync } from "node:fs";
import { query, accessToken, createSdkMcpServer, tool, AbortError } from "@qoder-ai/qoder-agent-sdk";
import { z } from "zod";
import {
  fakeTransportProvider,
  fakeSpawn,
  initFrame,
  assistantFrame,
  deltaFrame,
  resultFrame,
  waitFor,
} from "./lib/fake-transport.mjs";

const fixtureAuth = accessToken("fixture-token-never-sent");

function startQuery({ prompt = "synthetic prompt", recorder = {}, ...options } = {}) {
  const q = query({
    prompt,
    options: { auth: fixtureAuth, transport: fakeTransportProvider(recorder), ...options },
  });
  const seen = [];
  let iterError;
  const drain = (async () => {
    try {
      for await (const m of q) seen.push(m);
    } catch (err) {
      iterError = err;
    }
  })();
  return { q, recorder, seen, drain, get iterError() { return iterError; } };
}

async function afterInit(session) {
  await waitFor(
    () => session.recorder.transport?.written.some((l) => l.type === "control_request" && l.request?.type === "initialize"),
    { label: "initialize control_request" },
  );
  return session.recorder.transport;
}

test("A: spawnQoderCLIProcess seam captures launch args; tools:[] maps to empty --tools", { timeout: 20000 }, async () => {
  const captured = {};
  const q = query({
    prompt: "synthetic",
    options: {
      auth: fixtureAuth,
      pathToQoderCLIExecutable: "fake-qodercli-spike.exe",
      tools: [],
      disallowedTools: ["Bash", "Read", "Edit", "Write"],
      persistSession: false,
      settingSources: [],
      controlRequestTimeoutMs: 500,
      spawnQoderCLIProcess: fakeSpawn(captured),
      stderr: () => {},
    },
  });
  const consumed = (async () => {
    try {
      for await (const _ of q) void _;
    } catch {}
  })();
  await waitFor(() => captured.args, { label: "spawn capture" });
  assert.equal(captured.command, "fake-qodercli-spike.exe", "fixture spawned the fake path only, never a real qodercli");
  const args = captured.args;
  assert.ok(args.includes("--print"), "--print present");
  assert.ok(args.includes("--no-session-persistence"), "persistSession:false honored");
  const toolsIdx = args.indexOf("--tools");
  assert.ok(toolsIdx >= 0, "--tools flag emitted");
  assert.equal(args[toolsIdx + 1], "", "tools:[] serializes to empty --tools value");
  const disIdx = args.indexOf("--disallowed-tools");
  assert.ok(disIdx >= 0 && args[disIdx + 1] === "Bash", "disallowedTools reach CLI args");
  assert.ok(args.filter((a) => a === "--disallowed-tools").length === 4, "one flag per disallowed tool");
  assert.ok(!args.includes("--dangerously-skip-permissions"), "no permission bypass flag");
  assert.ok(!args.includes("--allowed-tools"), "no allowedTools flag when unset");
  assert.ok(!args.some((a) => a.includes("fixture-token")), "token never appears in argv");
  const payloadPath = captured.env.QODER_SDK_AUTH_PAYLOAD_FILE;
  assert.ok(typeof payloadPath === "string" && payloadPath.length > 0, "auth travels as a temp payload file path, not an argv flag");
  if (process.platform !== "win32") {
    // NTFS does not expose POSIX mode bits (statSync reports 0o666 even after chmod 0600);
    // on Windows the enforceable guarantees are payload-file indirection + removal on close.
    const payloadStat = statSync(payloadPath);
    assert.equal(payloadStat.mode & 0o777, 0o600, "auth payload file is owner-only while the session lives");
  }
  await q.close();
  await consumed;
  await waitFor(() => !existsSync(payloadPath), { timeoutMs: 5000, label: "auth payload removed on close" });
});

test("B: tools:[] and disallowedTools ride the transport launch options, not the initialize frame", { timeout: 15000 }, async () => {
  const session = startQuery({ tools: [], disallowedTools: ["Bash", "Read", "Edit", "Write"], settingSources: [] });
  const t = await afterInit(session);
  const launch = session.recorder.createOptions;
  assert.deepEqual(launch.tools, [], "launch options carry the explicit empty tool list");
  assert.deepEqual(launch.disallowedTools, ["Bash", "Read", "Edit", "Write"]);
  assert.equal(launch.allowedTools, undefined, "allowedTools unset, not permissive");
  assert.deepEqual(launch.settingSources, [], "settingSources reach launch options");
  const init = t.written.find((l) => l.type === "control_request" && l.request?.type === "initialize");
  assert.equal(init.request.sdkMcpServers, undefined, "no MCP servers registered");
  await session.q.close();
  await session.drain;
});

test("C: in-process MCP server exposes only the registered tool over the control channel", { timeout: 20000 }, async () => {
  const calls = [];
  const server = createSdkMcpServer({
    name: "search",
    tools: [
      tool("searchJobs", "synthetic search", { query: z.string() }, async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: JSON.stringify({ jobs: [{ id: "job-1" }] }) }] };
      }),
    ],
  });
  const session = startQuery({ mcpServers: { search: server } });
  const t = await afterInit(session);
  const init = t.written.find((l) => l.type === "control_request" && l.request?.type === "initialize");
  assert.deepEqual(init.request.sdkMcpServers, ["search"], "initialize advertises only the registered server");
  assert.equal(init.request.mcpServers, undefined, "in-process server never crosses the wire as process config");
  assert.equal(session.recorder.createOptions.mcpServers, undefined, "sdk servers stay out of the transport launch payload");

  const listResponse = await t.requestFromCli({ subtype: "mcp_message", server_name: "search", message: { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} } });
  assert.equal(listResponse.subtype, "success", "tools/list control response succeeded");
  const listRpc = listResponse.response.mcp_response;
  assert.equal(listRpc.id, 101, "json-rpc id correlates");
  const names = listRpc.result.tools.map((entry) => entry.name);
  assert.deepEqual(names, ["searchJobs"], "tools/list returns exactly the registered tool");

  const callResponse = await t.requestFromCli({
    subtype: "mcp_message",
    server_name: "search",
    message: { jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "searchJobs", arguments: { query: "backend" } } },
  });
  assert.equal(callResponse.subtype, "success");
  const callRpc = callResponse.response.mcp_response;
  assert.notEqual(callRpc.result?.isError, true, "tools/call succeeded");
  assert.equal(callRpc.result.content[0].text, JSON.stringify({ jobs: [{ id: "job-1" }] }), "handler result travels back through the control channel");
  assert.deepEqual(calls, [{ query: "backend" }], "handler executed in-process with zod-validated args");

  const badArgs = await t.requestFromCli({
    subtype: "mcp_message",
    server_name: "search",
    message: { jsonrpc: "2.0", id: 104, method: "tools/call", params: { name: "searchJobs", arguments: { query: 42 } } },
  });
  const badArgsRpc = badArgs.response?.mcp_response;
  assert.ok(badArgs.subtype === "error" || badArgsRpc?.error || badArgsRpc?.result?.isError === true, "zod-invalid args are rejected before the handler");
  assert.deepEqual(calls.length, 1, "invalid call never reached the handler");

  const unknown = await t.requestFromCli({
    subtype: "mcp_message",
    server_name: "search",
    message: { jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "Bash", arguments: { command: "whoami" } } },
  });
  const unknownRpc = unknown.response?.mcp_response;
  assert.ok(unknown.subtype === "error" || unknownRpc?.error || unknownRpc?.result?.isError === true, "unregistered tool call is rejected by the MCP server");
  assert.deepEqual(calls.length, 1, "rejected call never reached a handler");

  const wrongServer = await t.requestFromCli({
    subtype: "mcp_message",
    server_name: "other",
    message: { jsonrpc: "2.0", id: 105, method: "tools/list", params: {} },
  });
  assert.equal(wrongServer.subtype, "error", "unknown server name errors instead of routing");

  await session.q.close();
  await session.drain;
});

test("D: canUseTool deny is delivered as a permission decision; missing callback fails closed", { timeout: 15000 }, async () => {
  const decisions = [];
  const session = startQuery({
    canUseTool: async (toolName, input) => {
      decisions.push({ toolName, input });
      return { behavior: "deny", message: "shell tools are out of product bounds" };
    },
  });
  const t = await afterInit(session);
  const response = await t.requestFromCli({
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "whoami" },
    tool_use_id: "tu-1",
  });
  assert.equal(response.subtype, "success", "deny is a valid decision, not a protocol error");
  assert.equal(response.response.behavior, "deny");
  assert.equal(response.response.message, "shell tools are out of product bounds");
  assert.deepEqual(decisions, [{ toolName: "Bash", input: { command: "whoami" } }]);
  await session.q.close();
  await session.drain;

  const bare = startQuery({});
  const t2 = await afterInit(bare);
  const failClosed = await t2.requestFromCli({ subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: "tu-2" });
  assert.equal(failClosed.subtype, "error", "without canUseTool the SDK errors instead of allowing");
  assert.match(failClosed.error, /canUseTool/i);
  await bare.q.close();
  await bare.drain;
});

test("E: SDKMessage mapping — init, deltas, final text, usage/credits separation", { timeout: 15000 }, async () => {
  const session = startQuery({ includePartialMessages: true });
  const t = await afterInit(session);
  t.push(initFrame({ tools: [] }));
  t.push(deltaFrame("Hello "));
  t.push(deltaFrame("world"));
  t.push(assistantFrame({ text: "Hello world" }));
  t.push(resultFrame({ result: "Hello world", credits: 12 }));
  await session.drain;
  const seen = session.seen;

  const init = seen.find((m) => m.type === "system" && m.subtype === "init");
  assert.deepEqual(init.tools, [], "init frame reports the CLI-side tool list");
  assert.equal(init.protocol_version, "1.5.0", "wire protocol handshake observed");

  const deltas = seen.filter((m) => m.type === "stream_event");
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].event.delta.text, "Hello ", "delta text maps 1:1");
  assert.equal(deltas[1].event.delta.text, "world");

  const assistant = seen.find((m) => m.type === "assistant");
  assert.equal(assistant.message.content[0].text, "Hello world");
  assert.equal(assistant.message.usage.input_tokens, 11);

  const result = seen.find((m) => m.type === "result");
  assert.equal(result.subtype, "success");
  assert.equal(result.result, "Hello world", "final text lives on result.result");
  assert.equal(result.usage.credits, 12, "credits ride on usage.credits");
  assert.equal(result.total_credits, 12, "session-cumulative credits separate from USD");
  assert.equal(result.total_cost_usd, 0, "costUSD stays 0; credits are not USD");
});

test("F: error result subtypes surface as messages, not thrown exceptions", { timeout: 15000 }, async () => {
  const session = startQuery({});
  const t = await afterInit(session);
  t.push(initFrame());
  t.push(resultFrame({ subtype: "error_during_execution", errors: ["synthetic model failure"] }));
  await session.drain;
  const result = session.seen.find((m) => m.type === "result");
  assert.equal(result.subtype, "error_during_execution");
  assert.equal(result.is_error, true);
  assert.deepEqual(result.errors, ["synthetic model failure"]);
  assert.equal(session.iterError, undefined, "error result does not throw out of the iterator");
});

test("G: interrupt control request and AbortController cancel", { timeout: 20000 }, async () => {
  const session = startQuery({});
  const t = await afterInit(session);
  t.push(initFrame());

  const since = t.written.length;
  const interruptPromise = session.q.interrupt();
  const interruptReq = await t.waitForWritten((l) => l.type === "control_request" && l.request?.type === "interrupt", { since, label: "interrupt request" });
  t.push({ type: "control_response", response: { subtype: "success", request_id: interruptReq.request_id, response: { still_queued: ["queued-1"] } } });
  const interruptResult = await interruptPromise;
  assert.deepEqual(interruptResult.still_queued, ["queued-1"], "interrupt returns queued-message receipts");
  await session.q.close();
  await session.drain;

  const abortController = new AbortController();
  const aborted = startQuery({ abortController });
  const t2 = await afterInit(aborted);
  t2.push(initFrame());
  abortController.abort();
  await Promise.race([
    aborted.drain,
    waitFor(() => t2.closed, { timeoutMs: 8000, label: "abort closes transport" }),
  ]);
  await waitFor(() => t2.closed, { timeoutMs: 8000, label: "transport closed after abort" });
  assert.equal(aborted.iterError, undefined, "abort ends iteration cleanly instead of throwing into the consumer");
  const postAbort = aborted.q.interrupt();
  await assert.rejects(postAbort, (err) => {
    assert.ok(err instanceof AbortError || err?.name === "AbortError" || /clos|abort/i.test(err?.message ?? ""), `post-abort control request rejects, got ${err?.name}: ${err?.message}`);
    return true;
  }, "control requests after abort reject instead of hanging");
});

test("H: control request timeout cancels the request and surfaces as null usage", { timeout: 15000 }, async () => {
  const session = startQuery({ controlRequestTimeoutMs: 300, canUseTool: async () => ({ behavior: "allow" }) });
  const t = await afterInit(session);
  const since = t.written.length;
  const usagePromise = session.q.getUsageInfo();
  await t.waitForWritten((l) => l.type === "control_request" && l.request?.type === "get_usage_info", { since, label: "get_usage_info request" });
  const cancelLine = await t.waitForWritten((l) => l.type === "control_cancel_request", { since, label: "control_cancel_request after timeout" });
  assert.ok(cancelLine.request_id, "cancel references the timed-out request");
  const usage = await usagePromise;
  assert.equal(usage, null, "getUsageInfo swallows the timeout into null; the adapter must not read null as zero credits");
  await session.q.close();
  await session.drain;
});
