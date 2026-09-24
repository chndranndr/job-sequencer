import {
  query,
  qodercliAuth,
  type AuthOptions,
  type CanUseTool,
  type McpServerConfig,
  type ModelInfo,
  type PermissionResult,
  type Query,
  type QueryTransportOptions,
  type SDKMessage,
  type SDKUserMessage,
} from "@qoder-ai/qoder-agent-sdk";
import { isRecord, type AgentPromptOptions, type AgentSessionLike } from "./agent.js";

/**
 * QoderSession adapts @qoder-ai/qoder-agent-sdk query() to the repo's
 * runtime-neutral AgentSessionLike contract, so runBoundedAgent, its 14
 * callers, and every hand-faked test session keep working unchanged.
 *
 * Verified against spike/qoder-sdk (issue #24):
 * - ONE query() per session, fed by an AsyncIterable<SDKUserMessage> that stays
 *   open across prompts. Keeps the interview pool's re-prompt-same-session
 *   behavior on a single process without enabling transcript persistence.
 * - Tool boundary is defense-in-depth: tools:[] (proven live to mean no-tools),
 *   disallowedTools for builtins, and a fail-closed canUseTool allowlist that
 *   admits only this session's registered MCP tools.
 * - Credits are NOT USD: usage cost.total stays null; credits ride the message
 *   object for trajectory metadata only. See FINDINGS.md §Biaya.
 */

export const QODER_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "NotebookEdit",
] as const;

export type QoderSessionOptions = {
  systemPrompt?: string;
  /** Catalog `value` (e.g. "bailian-intl/qwen3.8-max-pg"); empty/undefined → account default. */
  model?: string;
  auth?: AuthOptions;
  /** Test seam: inject a faux QueryTransportProvider. Production omits it. */
  transport?: QueryTransportOptions;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Bare tool names per registered MCP server, e.g. { search: ["searchJobs"] }.
   * Required for the canUseTool allowlist: createSdkMcpServer's config carries
   * no tool-name descriptor (probed at runtime), so callers declare names.
   */
  mcpTools?: Record<string, readonly string[]>;
  disallowedTools?: readonly string[];
  cwd?: string;
  controlRequestTimeoutMs?: number;
  stderr?: (data: string) => void;
};

type PendingPrompt = { resolve: () => void; reject: (error: Error) => void };

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Repo targets ES2023, so Promise.withResolvers is unavailable; this is the one
// deferred primitive the adapter and its test seam share.
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Wire names for MCP tools are mcp__<server>__<tool>, each segment sanitized by
// the SDK's own ni() (verified in dist/index.js). Static membership per session,
// so a Record<string, true> is the right shape.
function registeredToolAllowlist(mcpTools: Record<string, readonly string[]> | undefined): Record<string, true> {
  const allow: Record<string, true> = {};
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  for (const [serverName, toolNames] of Object.entries(mcpTools ?? {})) {
    for (const toolName of toolNames) {
      if (toolName.length > 0) allow[`mcp__${sanitize(serverName)}__${sanitize(toolName)}`] = true;
    }
  }
  return allow;
}

class PromptQueue {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(step: { value: SDKUserMessage | undefined; done: boolean }) => void> = [];
  private ended = false;
  push(message: SDKUserMessage): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }
  end(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true });
  }
  async *iterate(): AsyncGenerator<SDKUserMessage, void, unknown> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      const { promise, resolve } = deferred<{ value: SDKUserMessage | undefined; done: boolean }>();
      this.waiters.push(resolve);
      const step = await promise;
      if (step.done) return;
      yield step.value as SDKUserMessage;
    }
  }
}

export class QoderSession implements AgentSessionLike {
  readonly systemPrompt?: string;
  readonly model?: unknown;

  private readonly query: Query;
  private readonly prompts = new PromptQueue();
  private readonly listeners = new Set<(event: unknown) => void>();
  private readonly allowlist: Record<string, true>;
  private readonly toolNamesByCallId = new Map<string, string>();

  private activeTools: string[] = [];
  private currentTimestamp: number | undefined;
  private blockText = "";
  private blockThinking = "";
  private pending: PendingPrompt | undefined;
  private abortRequested = false;
  private disposed = false;
  private sawInit = false;

  constructor(options: QoderSessionOptions) {
    this.systemPrompt = options.systemPrompt;
    this.model = options.model && options.model.length > 0 ? options.model : "account-default";
    this.allowlist = registeredToolAllowlist(options.mcpTools);

    const canUseTool: CanUseTool = async (toolName): Promise<PermissionResult> =>
      this.allowlist[toolName] === true
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Tool is outside Job Sequencer bounds" };

    this.query = query({
      prompt: this.prompts.iterate(),
      options: {
        auth: options.auth ?? qodercliAuth(),
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.model && options.model.length > 0 ? { model: options.model } : {}),
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.stderr ? { stderr: options.stderr } : {}),
        tools: [],
        disallowedTools: [...(options.disallowedTools ?? QODER_DISALLOWED_TOOLS)],
        permissionMode: "default",
        persistSession: false,
        settingSources: [],
        includePartialMessages: true,
        controlRequestTimeoutMs: options.controlRequestTimeoutMs ?? 30_000,
        canUseTool,
      },
    });
    void this.pump();
  }

  /** Resolve once the CLI handshake completes and the init tool list is known. */
  async ready(timeoutMs = 2_000): Promise<void> {
    await this.query.initializationResult();
    const deadline = Date.now() + timeoutMs;
    while (!this.sawInit && Date.now() < deadline) {
      const { promise, resolve } = deferred<void>();
      setTimeout(resolve, 10);
      await promise;
    }
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a faulty subscriber must not kill the pump */
      }
    }
  }

  // Every event for one assistant message must share a numeric timestamp: the
  // runner's assistantKey() groups deltas and the final message by it. Assign
  // lazily on the first delta when no message_start arrived, reset after the
  // assistant frame so the next message in the same turn gets a fresh key.
  private stamp(): number {
    this.currentTimestamp ??= Date.now();
    return this.currentTimestamp;
  }

  private assistantSkeleton() {
    return { role: "assistant", timestamp: this.stamp(), content: [] as Array<Record<string, unknown>> };
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query as AsyncIterable<SDKMessage>) {
        this.translate(message as unknown as Record<string, unknown>);
      }
      this.settleOnEnd();
    } catch (error) {
      this.emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private settleOnEnd(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    if (this.abortRequested) pending.resolve();
    else pending.reject(new Error("Qoder session ended without a result"));
  }

  private translate(message: Record<string, unknown>): void {
    const type = textOf(message.type);
    const subtype = textOf(message.subtype);
    if (type === "system" && subtype === "init") {
      this.activeTools = Array.isArray(message.tools) ? message.tools.map(textOf) : [];
      if (!this.sawInit) {
        this.sawInit = true;
        this.emit({ type: "agent_start" });
      }
      return;
    }
    if (type === "stream_event") {
      this.translateStreamEvent(isRecord(message.event) ? message.event : {});
      return;
    }
    if (type === "assistant") {
      this.translateAssistant(message);
      return;
    }
    if (type === "user") {
      this.translateUser(message);
      return;
    }
    if (type === "result") {
      this.translateResult(message);
      return;
    }
    if (type === "system" && subtype === "permission_denied") {
      this.emit({ type: "error", error: `permission_denied: ${textOf(message.tool_name)}` });
      return;
    }
    if (type === "system" && (subtype === "api_retry" || subtype === "mirror_error")) {
      this.emit({ type: "error", error: `${subtype}: ${textOf(message.error)}` });
    }
  }

  private translateStreamEvent(event: Record<string, unknown>): void {
    const kind = textOf(event.type);
    if (kind === "message_start") {
      this.currentTimestamp = Date.now();
      this.blockText = "";
      this.blockThinking = "";
      this.emit({ type: "message_start", message: this.assistantSkeleton() });
      return;
    }
    if (kind === "content_block_start") {
      const block = isRecord(event.content_block) ? event.content_block : {};
      if (textOf(block.type) === "thinking") this.blockThinking = "";
      else this.blockText = "";
      return;
    }
    if (kind === "content_block_delta") {
      const delta = isRecord(event.delta) ? event.delta : {};
      const deltaType = textOf(delta.type);
      if (deltaType === "text_delta") {
        const text = textOf(delta.text);
        this.blockText += text;
        this.emit({ type: "message_update", message: this.assistantSkeleton(), assistantMessageEvent: { type: "text_delta", delta: text } });
      } else if (deltaType === "thinking_delta") {
        const thinking = textOf(delta.thinking);
        this.blockThinking += thinking;
        this.emit({ type: "message_update", message: this.assistantSkeleton(), assistantMessageEvent: { type: "thinking_delta", delta: thinking } });
      }
      return;
    }
    if (kind === "content_block_stop") {
      // runs.ts reads text_end content; emit whichever block accumulated.
      if (this.blockThinking.length > 0) {
        this.emit({ type: "message_update", message: this.assistantSkeleton(), assistantMessageEvent: { type: "thinking_end", content: this.blockThinking } });
        this.blockThinking = "";
      } else {
        this.emit({ type: "message_update", message: this.assistantSkeleton(), assistantMessageEvent: { type: "text_end", content: this.blockText } });
      }
    }
  }

  private translateAssistant(message: Record<string, unknown>): void {
    const inner = isRecord(message.message) ? message.message : {};
    const content = Array.isArray(inner.content) ? inner.content : [];
    const usage = isRecord(inner.usage) ? inner.usage : undefined;
    const input = finiteOr(usage?.input_tokens);
    const output = finiteOr(usage?.output_tokens);
    const piContent: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      const blockType = textOf(block.type);
      if (blockType === "text") {
        piContent.push({ type: "text", text: textOf(block.text) });
      } else if (blockType === "tool_use") {
        const toolCallId = textOf(block.id);
        const toolName = textOf(block.name);
        this.toolNamesByCallId.set(toolCallId, toolName);
        this.emit({ type: "tool_execution_start", toolCallId, toolName, args: block.input });
      }
    }
    const piMessage: Record<string, unknown> = {
      role: "assistant",
      timestamp: this.stamp(),
      content: piContent,
      provider: "qoder",
      model: textOf(inner.model) || undefined,
      stopReason: inner.stop_reason === undefined || inner.stop_reason === null ? undefined : textOf(inner.stop_reason),
      usage: { input, output, totalTokens: input !== null && output !== null ? input + output : null, cost: null },
    };
    if (usage?.credits !== undefined) piMessage.credits = finiteOr(usage.credits);
    if (message.error !== undefined) this.emit({ type: "error", error: textOf(message.error) });
    this.emit({ type: "message_end", message: piMessage });
    this.currentTimestamp = undefined;
    this.blockText = "";
    this.blockThinking = "";
  }

  private translateUser(message: Record<string, unknown>): void {
    const inner = isRecord(message.message) ? message.message : {};
    const content = Array.isArray(inner.content) ? inner.content : [];
    for (const block of content) {
      if (!isRecord(block) || textOf(block.type) !== "tool_result") continue;
      const toolCallId = textOf(block.tool_use_id);
      this.emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: this.toolNamesByCallId.get(toolCallId) ?? "",
        result: block.content,
        isError: block.is_error === true,
      });
      this.toolNamesByCallId.delete(toolCallId);
    }
  }

  private translateResult(message: Record<string, unknown>): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const subtype = textOf(message.subtype);
    if (subtype === "success") {
      pending.resolve();
      return;
    }
    const errors = Array.isArray(message.errors) ? message.errors.map(textOf) : [];
    pending.reject(new Error(`Qoder run failed (${subtype})${errors.length ? `: ${errors.join("; ")}` : ""}`));
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string, options?: AgentPromptOptions): Promise<void> {
    if (this.disposed) throw new Error("Qoder session is disposed");
    if (this.pending) throw new Error("Qoder session is busy");
    const images = options?.images ?? [];
    const blocks: Array<Record<string, unknown>> = [];
    if (text.length > 0) blocks.push({ type: "text", text });
    for (const image of images) blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    const { promise, resolve, reject } = deferred<void>();
    this.pending = { resolve, reject };
    this.currentTimestamp = undefined;
    // Wire shape is SDKUserMessage; content is string|ContentBlock[]. Cast at the
    // boundary — the frame the CLI receives, not internal typed data.
    this.prompts.push({
      type: "user",
      message: { role: "user", content: images.length > 0 ? blocks : text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    return promise;
  }

  async abort(): Promise<void> {
    if (this.abortRequested) return;
    this.abortRequested = true;
    try {
      await this.query.interrupt();
    } catch {
      /* the pump settles the pending prompt when iteration ends */
    }
    await this.query.close().catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.prompts.end();
    void this.query.close().catch(() => {});
  }

  /** Account model catalog (control request; zero inference, proven 0-credit in the phase-0 probe). */
  listModels(): Promise<ModelInfo[]> {
    return this.query.getAvailableModels({ fetchStrategy: "live" });
  }

  getActiveToolNames(): string[] {
    return [...this.activeTools];
  }

  getAllTools(): unknown[] {
    return this.activeTools.map((name) => ({ name }));
  }
}

export async function createQoderSession(options: QoderSessionOptions): Promise<QoderSession> {
  const session = new QoderSession(options);
  await session.ready();
  return session;
}
