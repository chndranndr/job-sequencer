import { createSdkMcpServer, tool, type McpServerConfig } from "@qoder-ai/qoder-agent-sdk";
import type { CallToolResult } from "@qoder-ai/qoder-agent-sdk";
import type { z } from "zod";

/**
 * Runtime-neutral agent tool definition. Replaces Pi's defineTool/ToolDefinition
 * (TypeBox parameters + 5-arg execute). The Qoder SDK reaches tools through an
 * in-process MCP server (createSdkMcpServer + tool()), whose handler signature is
 * (args, extra) with a zod raw shape for the model-facing schema.
 *
 * Two callers exist and stay distinct:
 * - Internal direct callers (preflight in runs.ts, cross-tool calls, tests) invoke
 *   execute() and read BOTH content and details.
 * - The model reaches tools through MCP; only content crosses that wire, so the
 *   MCP handler below forwards content and keeps details in-process. This matches
 *   plan §1.4 ("pertahankan metadata hasil details bagi pemanggil internal").
 */

export type AgentToolContent = { type: "text"; text: string };

export type AgentToolResult<TDetails = unknown> = {
  content: AgentToolContent[];
  details: TDetails;
};

export type AgentToolDefinition<TDetails = unknown> = {
  name: string;
  label: string;
  description: string;
  /** Zod raw shape; the single source for both the MCP schema and internal parse. */
  schema: z.ZodRawShape;
  /**
   * @param toolCallId stable id for this invocation (MCP requestId, or caller-supplied)
   * @param params already-validated arguments
   * @param signal cancellation from the caller or the MCP transport
   * @param onUpdate optional partial-result stream (unused by current tools)
   */
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate?: (partial: AgentToolResult<TDetails>) => void,
  ): Promise<AgentToolResult<TDetails>>;
};

export function defineAgentTool<TDetails = unknown>(definition: AgentToolDefinition<TDetails>): AgentToolDefinition<TDetails> {
  return definition;
}

/**
 * A promise-chain mutex serializing tool execution within one MCP server.
 * Pi exposed executionMode:"sequential"; the Qoder tool() surface has no visible
 * equivalent (spike: belum terverifikasi), so AgentSearchState mutators are
 * serialized here to keep budget/provenance/finishSearch race-free.
 * ponytail: one lock per server (all current tools are sequential); per-tool
 * locks only if a future server mixes blocking and parallel-safe tools.
 */
function createSerialGate() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export type SdkMcpBundle = {
  server: McpServerConfig;
  /** Bare tool names, for the QoderSession canUseTool allowlist. */
  toolNames: string[];
};

/**
 * Wrap neutral tool definitions as one in-process Qoder MCP server. Execution is
 * serialized per server. Handler errors become MCP isError results so the model
 * sees a tool failure rather than crashing the session; validation stays in each
 * tool's own execute (unchanged from the Pi version).
 */
export function createAgentMcpServer(serverName: string, definitions: readonly AgentToolDefinition[]): SdkMcpBundle {
  const gate = createSerialGate();
  const tools = definitions.map((definition) =>
    tool(
      definition.name,
      definition.description,
      definition.schema,
      async (args, extra): Promise<CallToolResult> =>
        gate(async () => {
          const toolCallId = typeof extra?.requestId === "string" ? extra.requestId : String(extra?.requestId ?? definition.name);
          try {
            const result = await definition.execute(
              toolCallId,
              args as Record<string, unknown>,
              extra?.signal,
            );
            return { content: result.content };
          } catch (error) {
            return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
          }
        }),
    ),
  );
  return {
    server: createSdkMcpServer({ name: serverName, tools }),
    toolNames: definitions.map((definition) => definition.name),
  };
}
