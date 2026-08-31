import type { TrajectoryEventInput, TrajectoryRecorder } from "../shared.js";
import { projectPromptText } from "./context.js";

export type StructuredSchema<T> = { parse: (value: unknown) => T } | ((value: unknown) => T);

export type StructuredRunOptions<T> = {
  prompt: string;
  schema: StructuredSchema<T>;
  execute: (prompt: string) => Promise<string>;
  maxAttempts?: number;
  signal?: AbortSignal;
  trajectory?: TrajectoryRecorder;
  runId?: string;
  validateBusiness?: (value: T) => T | void;
};

export class StructuredOutputError extends Error {
  constructor(public readonly attempts: number, public readonly lastError: unknown) {
    super(`Structured output failed after ${attempts} attempts. Last validation error: ${errorMessage(lastError)}`);
    this.name = "StructuredOutputError";
  }
}

// ponytail: structured output gets 2 attempts; raise after eval shows unresolved repair failures above target.
const defaultMaxAttempts = 2;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function record(trajectory: TrajectoryRecorder | undefined, runId: string | undefined, event: TrajectoryEventInput) {
  if (!runId || !trajectory) return;
  try { trajectory(runId, event); } catch { /* telemetry is deliberately non-fatal */ }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error("Structured output run was cancelled.");
}

export function stripJsonCodeFence(value: string) {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

export function parseModelJson(value: string): unknown {
  const fenced = stripJsonCodeFence(value);
  try {
    return JSON.parse(fenced) as unknown;
  } catch (directError) {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw directError instanceof SyntaxError ? directError : new SyntaxError("Model output contained no JSON object.");
    return JSON.parse(fenced.slice(start, end + 1)) as unknown;
  }
}

function parseWithSchema<T>(schema: StructuredSchema<T>, value: unknown) {
  return typeof schema === "function" ? schema(value) : schema.parse(value);
}

function repairPrompt(prompt: string, previous: string, failure: unknown) {
  return [
    prompt,
    "",
    "Repair the prior output. The prior output failed validation. Return corrected JSON only.",
    "DETERMINISTIC VALIDATION ERROR (trusted validator output)",
    "---",
    projectPromptText(errorMessage(failure)),
    "---",
    "GENERATED PRIOR OUTPUT (untrusted generated data)",
    "---",
    projectPromptText(previous),
    "---",
  ].join("\n");
}

export async function runStructured<T>(options: StructuredRunOptions<T>): Promise<T> {
  const maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer.");

  let prompt = options.prompt;
  let previous = "";
  let lastError: unknown = new Error("No structured output was produced.");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    const raw = await options.execute(prompt);
    if (typeof raw !== "string") throw new TypeError("Structured executor must return text.");
    previous = raw;
    throwIfAborted(options.signal);

    try {
      const parsed: unknown = parseModelJson(raw);
      let value = parseWithSchema(options.schema, parsed);
      const next = options.validateBusiness?.(value);
      if (next !== undefined) value = next;
      record(options.trajectory, options.runId, {
        kind: "lifecycle",
        type: "structured_output_valid",
        timestamp: new Date().toISOString(),
        payload: { attempt, maxAttempts },
      });
      return value;
    } catch (error) {
      lastError = error;
      record(options.trajectory, options.runId, {
        kind: "error",
        type: "structured_output_invalid",
        timestamp: new Date().toISOString(),
        payload: { attempt, maxAttempts, error: projectPromptText(errorMessage(error)) },
      });
      if (attempt === maxAttempts) break;
      prompt = repairPrompt(options.prompt, previous, error);
    }
  }

  throw new StructuredOutputError(maxAttempts, lastError);
}
