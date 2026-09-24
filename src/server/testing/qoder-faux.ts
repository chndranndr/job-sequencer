import type { Transport, QueryTransportProvider } from "@qoder-ai/qoder-agent-sdk";

/**
 * Offline test seam for the Qoder adapter. Ports the phase-0 spike fixture
 * (spike/qoder-sdk/lib/fake-transport.mjs) to TypeScript. The test side plays
 * qodercli: push() frames the CLI would emit on stdout; written[] captures
 * every JSON line the SDK sends. No process, no network, no auth.
 *
 * Frames the CLI would emit are typed loosely on purpose: the wire is a union
 * the SDK owns, and a fake CLI is allowed to emit minimal-but-valid shapes.
 * Casts are confined to frame factories below and documented at each site.
 */

/** One parsed JSONL line in either direction. */
export type WireFrame = Record<string, unknown> & { type?: string };

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(step: { value: T | undefined; done: boolean }) => void> = [];
  private ended = false;
  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true });
  }
  async *iterate(): AsyncGenerator<T, void, unknown> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      const step = await new Promise<{ value: T | undefined; done: boolean }>((resolve) => this.waiters.push(resolve));
      if (step.done) return;
      yield step.value as T;
    }
  }
}

const DEFAULT_INIT_RESPONSE = {
  commands: [],
  agents: [],
  skills: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: [{ value: "faux-model", displayName: "Faux", description: "fixture" }],
  account: {},
  capabilities: [],
};

export type RecordingTransportOptions = {
  initResponse?: Record<string, unknown>;
  /**
   * Called when the SDK writes a `user` line, returning frames the CLI would
   * emit in response (assistant/result). Lets the offline smoke and generation
   * factories drive scripted turns without Pi's fauxProvider.
   */
  onUserMessage?: (message: WireFrame) => WireFrame[];
  /** When set, emitted as a system/init stream frame right after the handshake. */
  initFrame?: WireFrame;
};

export class RecordingTransport implements Transport {
  readonly written: WireFrame[] = [];
  closed = false;
  inputEnded = false;
  ready = false;
  private readonly queue = new AsyncQueue<WireFrame>();
  private pending: string[] = [];
  private readonly initResponse: Record<string, unknown>;
  private readonly onUserMessage: ((message: WireFrame) => WireFrame[]) | undefined;
  private readonly initFrame: WireFrame | undefined;

  constructor(options: RecordingTransportOptions = {}) {
    this.initResponse = options.initResponse ?? DEFAULT_INIT_RESPONSE;
    this.onUserMessage = options.onUserMessage;
    this.initFrame = options.initFrame;
  }

  async initialize(): Promise<void> {
    this.ready = true;
    const buffered = this.pending;
    this.pending = [];
    for (const line of buffered) this.handleLine(line);
  }

  write(data: string): void {
    if (this.closed) throw new Error("Transport has been closed");
    const lines = String(data).split("\n").filter((line) => line.length > 0);
    if (!this.ready) {
      this.pending.push(...lines);
      return;
    }
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    const parsed = JSON.parse(line) as WireFrame;
    this.written.push(parsed);
    const request = parsed.request as WireFrame | undefined;
    if (parsed.type === "control_request" && request?.type === "initialize") {
      this.push({
        type: "control_response",
        response: { subtype: "success", request_id: parsed.request_id, response: this.initResponse },
      });
      if (this.initFrame) this.push(this.initFrame);
    } else if (parsed.type === "control_request" && request?.type === "interrupt") {
      // A real CLI answers interrupt with the queued-message receipts; abort()
      // awaits it, so answer promptly or the adapter burns the control timeout.
      this.push({
        type: "control_response",
        response: { subtype: "success", request_id: parsed.request_id, response: { still_queued: [] } },
      });
    } else if (parsed.type === "user" && this.onUserMessage) {
      for (const frame of this.onUserMessage(parsed)) this.push(frame);
    }
  }

  close(): void {
    this.closed = true;
    this.queue.end();
  }

  isReady(): boolean {
    return this.ready && !this.closed;
  }

  endInput(): void {
    this.inputEnded = true;
    // A real one-shot CLI exits after stdin closes; the fake mirrors that so the
    // SDK's readMessages() completes and the consumer iterator terminates.
    this.queue.end();
  }

  readMessages(): AsyncGenerator<never, void, unknown> {
    // The SDK types readMessages() as AsyncGenerator<StdoutMessage>. The fake
    // emits WireFrame values the SDK parses structurally; cast at the boundary.
    return this.queue.iterate() as unknown as AsyncGenerator<never, void, unknown>;
  }

  /** Test-side: enqueue one frame as if the CLI emitted it on stdout. */
  push(message: WireFrame): void {
    this.queue.push(message);
  }

  /** Test-side: await a written line matching predicate, scanning from index >= since. */
  waitForWritten(predicate: (line: WireFrame) => boolean, { since = 0, timeoutMs = 5000, label = "written line" } = {}): Promise<WireFrame> {
    return waitFor(() => this.written.slice(since).find(predicate), { timeoutMs, label });
  }

  waitForResponse(requestId: string, options: { since?: number; timeoutMs?: number } = {}): Promise<WireFrame> {
    return this.waitForWritten(
      (line) => line.type === "control_response" && (line.response as WireFrame | undefined)?.request_id === requestId,
      { label: `control_response ${requestId}`, ...options },
    );
  }

  /** Send an inbound control_request as the CLI would; resolve the SDK's response envelope. */
  async requestFromCli(request: WireFrame, { timeoutMs = 5000 } = {}): Promise<WireFrame> {
    const requestId = `cli-${Math.random().toString(36).slice(2)}`;
    const since = this.written.length;
    this.push({ type: "control_request", request_id: requestId, request });
    const line = await this.waitForResponse(requestId, { since, timeoutMs });
    return line.response as WireFrame;
  }
}

export type FauxRecorder = {
  transport?: RecordingTransport;
  createOptions?: Record<string, unknown>;
  transportOptions?: RecordingTransportOptions;
};

export function fauxTransportProvider(recorder: FauxRecorder = {}): QueryTransportProvider<Record<string, unknown>> {
  return {
    create(options: Record<string, unknown>): Transport {
      const transport = new RecordingTransport(recorder.transportOptions);
      recorder.transport = transport;
      recorder.createOptions = options;
      return transport;
    },
  };
}

export async function waitFor<T>(predicate: () => T | undefined, { timeoutMs = 5000, label = "condition" } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

// ---- Frame factories: minimal-but-valid shapes the CLI would emit ----

export function fauxInitFrame({ tools = [], sessionId = "faux-session", model = "faux-model" }: { tools?: string[]; sessionId?: string; model?: string } = {}): WireFrame {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "user",
    qodercli_version: "1.1.62",
    protocol_version: "1.5.0",
    cwd: process.cwd(),
    tools,
    mcp_servers: [],
    model,
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

export type FauxUsage = { input_tokens?: number; output_tokens?: number; credits?: number; billable?: boolean };

export function fauxAssistantFrame({
  text,
  toolUse,
  usage,
  error,
  sessionId = "faux-session",
  model = "faux-model",
  stopReason,
}: {
  text?: string;
  toolUse?: Array<{ id: string; name: string; input: unknown }>;
  usage?: FauxUsage;
  error?: string;
  sessionId?: string;
  model?: string;
  stopReason?: string;
}): WireFrame {
  const content: WireFrame[] = [];
  if (text !== undefined) content.push({ type: "text", text });
  for (const call of toolUse ?? []) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  return {
    type: "assistant",
    message: {
      id: `msg-${Math.random().toString(36).slice(2)}`,
      type: "message",
      role: "assistant",
      content,
      model,
      stop_reason: stopReason ?? (toolUse?.length ? "tool_use" : "end_turn"),
      usage: usage ?? {},
    },
    parent_tool_use_id: null,
    ...(error ? { error, isApiErrorMessage: true } : {}),
    uuid: `assistant-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  };
}

export function fauxToolResultFrame(toolUseId: string, result: unknown, { isError = false, sessionId = "faux-session" } = {}): WireFrame {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result, is_error: isError }] },
    parent_tool_use_id: null,
    uuid: `toolresult-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  };
}

export function fauxDeltaFrame(text: string, { index = 0, sessionId = "faux-session" } = {}): WireFrame {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
    uuid: `delta-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  };
}

export function fauxThinkingDeltaFrame(thinking: string, { index = 1, sessionId = "faux-session" } = {}): WireFrame {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } },
    parent_tool_use_id: null,
    uuid: `think-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  };
}

export function fauxContentBlockStopFrame({ index = 0, sessionId = "faux-session" } = {}): WireFrame {
  return {
    type: "stream_event",
    event: { type: "content_block_stop", index },
    parent_tool_use_id: null,
    uuid: `stop-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  };
}

export function fauxMessageStartFrame({ sessionId = "faux-session" } = {}): WireFrame {
  return {
    type: "stream_event",
    event: { type: "message_start", message: { role: "assistant", content: [] } },
    parent_tool_use_id: null,
    uuid: `mstart-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
  };
}

export function fauxResultFrame({
  subtype = "success",
  result = "final synthetic text",
  errors,
  sessionId = "faux-session",
  credits = 0,
}: {
  subtype?: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd";
  result?: string;
  errors?: string[];
  sessionId?: string;
  credits?: number;
} = {}): WireFrame {
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
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: "result-uuid",
    session_id: sessionId,
  };
  if (subtype === "success") return { ...base, result };
  return { ...base, errors: errors ?? ["synthetic failure"] };
}
