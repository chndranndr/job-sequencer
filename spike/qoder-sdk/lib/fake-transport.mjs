import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

class AsyncQueue {
  #items = [];
  #waiters = [];
  #ended = false;
  push(item) {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }
  end() {
    this.#ended = true;
    while (this.#waiters.length > 0) this.#waiters.shift()({ value: undefined, done: true });
  }
  async *iterate() {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift();
        continue;
      }
      if (this.#ended) return;
      const step = await new Promise((resolve) => this.#waiters.push(resolve));
      if (step.done) return;
      yield step.value;
    }
  }
}

const INIT_RESPONSE = {
  commands: [],
  agents: [],
  skills: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: [{ value: "synthetic-model", displayName: "Synthetic", description: "fixture" }],
  account: { userId: "fixture-user", tokenSource: "accessToken" },
  capabilities: [],
};

/**
 * Implements the SDK's Transport interface (dist/core/transport.d.ts) without
 * any qodercli process. The test side plays the CLI: push() frames the CLI
 * would emit on stdout; written[] captures every JSON line the SDK sends.
 */
export class RecordingTransport {
  written = [];
  closed = false;
  inputEnded = false;
  ready = false;
  #queue = new AsyncQueue();
  #pending = [];
  #initResponse;
  constructor({ initResponse = INIT_RESPONSE } = {}) {
    this.#initResponse = initResponse;
  }
  async initialize() {
    this.ready = true;
    const buffered = this.#pending;
    this.#pending = [];
    for (const line of buffered) this.#handleLine(line);
  }
  write(data) {
    if (this.closed) throw new Error("Transport has been closed");
    const lines = String(data).split("\n").filter((l) => l.length > 0);
    if (!this.ready) {
      this.#pending.push(...lines);
      return;
    }
    for (const line of lines) this.#handleLine(line);
  }
  #handleLine(line) {
    const parsed = JSON.parse(line);
    this.written.push(parsed);
    if (parsed.type === "control_request" && parsed.request?.type === "initialize") {
      this.push({
        type: "control_response",
        response: { subtype: "success", request_id: parsed.request_id, response: this.#initResponse },
      });
    }
  }
  close() {
    this.closed = true;
    this.#queue.end();
  }
  isReady() {
    return this.ready && !this.closed;
  }
  endInput() {
    this.inputEnded = true;
    // A real one-shot CLI exits after stdin closes; the fake mirrors that so
    // readMessages completes and the consumer iterator terminates.
    this.#queue.end();
  }
  readMessages() {
    return this.#queue.iterate();
  }
  /** Test-side: enqueue one frame as if the CLI emitted it on stdout. */
  push(message) {
    this.#queue.push(message);
  }
  /** Test-side: wait for a written line matching predicate, from index >= since. */
  waitForWritten(predicate, { since = 0, timeoutMs = 5000, label = "written line" } = {}) {
    return waitFor(() => this.written.slice(since).find(predicate), { timeoutMs, label });
  }
  waitForResponse(requestId, options = {}) {
    return this.waitForWritten(
      (line) => line.type === "control_response" && line.response?.request_id === requestId,
      { label: `control_response ${requestId}`, ...options },
    );
  }
  nextRequestId(prefix) {
    return `${prefix}-${this.written.length}`;
  }
  /** Send an inbound control_request as the CLI would and await the SDK's response. */
  async requestFromCli(request, { timeoutMs = 5000 } = {}) {
    const requestId = `cli-${Math.random().toString(36).slice(2)}`;
    const since = this.written.length;
    this.push({ type: "control_request", request_id: requestId, request });
    const line = await this.waitForResponse(requestId, { since, timeoutMs });
    return line.response;
  }
}

export async function waitFor(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function fakeTransportProvider(recorder = {}) {
  return {
    create(options) {
      const transport = new RecordingTransport(recorder.transportOptions);
      recorder.transport = transport;
      recorder.createOptions = options;
      return transport;
    },
  };
}

export function initFrame({ tools = [], sessionId = "fixture-session", mcpServers = [] } = {}) {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "access_token",
    qodercli_version: "1.1.62",
    protocol_version: "1.5.0",
    cwd: process.cwd(),
    tools,
    mcp_servers: mcpServers,
    model: "synthetic-model",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    capabilities: [],
    uuid: "init-uuid",
    session_id: sessionId,
  };
}

export function assistantFrame({ text, toolUse, sessionId = "fixture-session", error } = {}) {
  const content = [];
  if (text !== undefined) content.push({ type: "text", text });
  if (toolUse) content.push({ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input });
  return {
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      content,
      model: "synthetic-model",
      stop_reason: toolUse ? "tool_use" : "end_turn",
      usage: { input_tokens: 11, output_tokens: 7 },
    },
    parent_tool_use_id: null,
    ...(error ? { error, isApiErrorMessage: true } : {}),
    uuid: `assistant-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  };
}

export function deltaFrame(text, { index = 0, sessionId = "fixture-session" } = {}) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
    uuid: `delta-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  };
}

export function resultFrame({ subtype = "success", result = "final synthetic text", errors, sessionId = "fixture-session", credits = 12 } = {}) {
  const base = {
    type: "result",
    subtype,
    duration_ms: 40,
    duration_api_ms: 30,
    is_error: subtype !== "success",
    num_turns: 1,
    stop_reason: subtype === "success" ? "end_turn" : null,
    total_cost_usd: 0,
    total_credits: credits,
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "fixture",
      input_tokens: 11,
      iterations: [],
      output_tokens: 7,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "fixture",
      speed: "fixture",
      credits,
    },
    modelUsage: {
      "synthetic-model": {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        credits,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
    permission_denials: [],
    uuid: "result-uuid",
    session_id: sessionId,
  };
  if (subtype === "success") return { ...base, result };
  return { ...base, errors: errors ?? ["synthetic failure"] };
}

/** Fake SpawnedProcess for options.spawnQoderCLIProcess: captures launch args, never boots a binary. */
export function fakeSpawn(captured) {
  return (spawnOptions) => {
    captured.command = spawnOptions.command;
    captured.args = spawnOptions.args;
    captured.env = spawnOptions.env;
    captured.signal = spawnOptions.signal;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const emitter = new EventEmitter();
    captured.stdin = stdin;
    captured.stdout = stdout;
    captured.endStdout = () => stdout.end();
    return {
      stdin,
      stdout,
      get killed() {
        return captured.killed ?? false;
      },
      get exitCode() {
        return captured.exitCode ?? null;
      },
      kill(signal) {
        captured.killed = true;
        captured.killSignal = signal;
        stdout.end();
        emitter.emit("exit", 0, signal);
        return true;
      },
      on: (event, listener) => emitter.on(event, listener),
      once: (event, listener) => emitter.once(event, listener),
      off: (event, listener) => emitter.off(event, listener),
    };
  };
}
