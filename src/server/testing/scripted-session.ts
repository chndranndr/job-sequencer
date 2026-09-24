import type { AgentSessionLike, AgentPromptOptions } from "../agent.js";
import type { AgentToolDefinition } from "../tools.js";

/**
 * ScriptedAgentSession: offline test seam implementing AgentSessionLike.
 * Replaces the Pi fauxProvider fixtures (plan §3.1): a script observes the
 * transcript (user prompts + real tool results) and returns the next action;
 * tool actions EXECUTE the real domain tools, so budget, provenance, and
 * finishSearch enforcement are genuinely exercised without any provider,
 * CLI binary, or protocol emulation.
 *
 * Emitted events match the shapes runBoundedAgent and callers consume:
 * message_update/assistantMessageEvent text_delta, message_end with Pi-shaped
 * usage, tool_execution_start/end, agent_start/agent_end.
 */

export type ScriptToolResult = {
  role: "toolResult";
  toolName: string;
  toolCallId: string;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  details?: unknown;
};

export type ScriptMessage =
  | { role: "user"; content: Array<{ type: "text"; text: string }> }
  | ScriptToolResult;

export type ScriptContext = { messages: ScriptMessage[] };

export type ScriptAction =
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "text"; text: string; usage?: ScriptedUsage };

export type ScriptedUsage = { input: number; output: number; totalTokens: number; costTotal?: number | null };

export type ScriptedSessionOptions = {
  tools?: readonly AgentToolDefinition[];
  script: (context: ScriptContext) => ScriptAction | Promise<ScriptAction>;
  systemPrompt?: string;
  usage?: ScriptedUsage;
  /** Emit text in chunks of this many characters (default 4, like the pool fakes). */
  chunkSize?: number;
  maxSteps?: number;
};

export class ScriptedAgentSession implements AgentSessionLike {
  readonly systemPrompt?: string;
  readonly model = { provider: "scripted", id: "offline" };

  private readonly listeners = new Set<(event: unknown) => void>();
  private readonly messages: ScriptMessage[] = [];
  private readonly toolsByName: Map<string, AgentToolDefinition>;
  private disposed = false;

  constructor(private readonly options: ScriptedSessionOptions) {
    this.systemPrompt = options.systemPrompt;
    this.toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string, _options?: AgentPromptOptions): Promise<void> {
    if (this.disposed) throw new Error("Scripted session is disposed");
    this.emit({ type: "agent_start" });
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    const maxSteps = this.options.maxSteps ?? 64;
    for (let step = 0; step < maxSteps; step += 1) {
      const action = await this.options.script({ messages: [...this.messages] });
      if (action.kind === "tool") {
        await this.runTool(action);
        continue;
      }
      this.emitText(action.text, action.usage ?? this.options.usage);
      this.emit({ type: "agent_end", messages: [] });
      return;
    }
    throw new Error(`Scripted session exceeded ${maxSteps} steps without a final text action`);
  }

  private async runTool(action: Extract<ScriptAction, { kind: "tool" }>): Promise<void> {
    const tool = this.toolsByName.get(action.name);
    this.emit({ type: "tool_execution_start", toolCallId: action.id, toolName: action.name, args: action.args });
    if (!tool) {
      this.messages.push({
        role: "toolResult",
        toolName: action.name,
        toolCallId: action.id,
        content: [{ type: "text", text: `Unknown tool ${action.name}` }],
        isError: true,
      });
      this.emit({ type: "tool_execution_end", toolCallId: action.id, toolName: action.name, result: `Unknown tool ${action.name}`, isError: true });
      return;
    }
    try {
      const result = await tool.execute(action.id, action.args, undefined);
      this.messages.push({
        role: "toolResult",
        toolName: action.name,
        toolCallId: action.id,
        content: result.content,
        isError: false,
        details: result.details,
      });
      this.emit({ type: "tool_execution_end", toolCallId: action.id, toolName: action.name, result: result.content, isError: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.messages.push({
        role: "toolResult",
        toolName: action.name,
        toolCallId: action.id,
        content: [{ type: "text", text: message }],
        isError: true,
      });
      this.emit({ type: "tool_execution_end", toolCallId: action.id, toolName: action.name, result: message, isError: true });
    }
  }

  private emitText(text: string, usage?: ScriptedUsage): void {
    const timestamp = Date.now();
    const chunkSize = Math.max(1, this.options.chunkSize ?? 4);
    for (let index = 0; index < text.length; index += chunkSize) {
      this.emit({
        type: "message_update",
        message: { role: "assistant", timestamp, content: [] },
        assistantMessageEvent: { type: "text_delta", delta: text.slice(index, index + chunkSize) },
      });
    }
    this.emit({
      type: "message_update",
      message: { role: "assistant", timestamp, content: [] },
      assistantMessageEvent: { type: "text_end", content: text },
    });
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp,
        content: [{ type: "text", text }],
        provider: "scripted",
        model: "offline",
        stopReason: "end_turn",
        usage: usage
          ? { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, cost: { total: usage.costTotal ?? null } }
          : undefined,
      },
    });
  }

  async abort(): Promise<void> {
    /* scripted prompts are synchronous; nothing to interrupt */
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  getActiveToolNames(): string[] {
    return [...this.toolsByName.keys()];
  }

  getAllTools(): unknown[] {
    return [...this.toolsByName.values()];
  }
}

export function createScriptedSession(options: ScriptedSessionOptions): ScriptedAgentSession {
  return new ScriptedAgentSession(options);
}
