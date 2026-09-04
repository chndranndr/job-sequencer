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

const validJsonEscapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

// ponytail: repair only unambiguous LLM syntax slips; schema and business validation remain the gate.
function repairJsonStringLiterals(value: string) {
  let repaired = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (!inString) {
      repaired += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      repaired += character;
      escaped = false;
      continue;
    }
    if (character === '"') {
      const next = value.slice(index + 1).match(/\S/)?.[0];
      if (next && ![",", "}", "]", ":"].includes(next) && next !== '"') {
        repaired += '\\"';
        continue;
      }
      repaired += character;
      inString = false;
      continue;
    }
    if (character === "\\") {
      const next = value[index + 1];
      if (next === undefined) {
        repaired += "\\\\";
        continue;
      }
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))) {
        repaired += `\\u${value.slice(index + 2, index + 6)}`;
        index += 5;
        continue;
      }
      if (validJsonEscapes.has(next)) {
        repaired += `\\${next}`;
        index += 1;
        continue;
      }
      repaired += "\\\\";
      continue;
    }
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x1f) {
      const escapedControl = { "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" }[character];
      repaired += escapedControl ?? `\\u${codePoint.toString(16).padStart(4, "0")}`;
      continue;
    }
    repaired += character;
  }
  return repaired;
}

function repairMissingJsonCommas(value: string) {
  let repaired = "";
  let inString = false;
  let escaped = false;
  let lastSignificant = "";
  const containers: string[] = [];
  for (const character of value) {
    if (inString) {
      repaired += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        inString = false;
        lastSignificant = '"';
      }
      continue;
    }
    if (character === '"') {
      const parent = containers.at(-1);
      if ((parent === "{" || parent === "[") && /["\]}0-9eln]/i.test(lastSignificant)) repaired += ",";
      inString = true;
      repaired += character;
      continue;
    }
    if (character === "{" || character === "[") containers.push(character);
    else if (character === "}" || character === "]") containers.pop();
    repaired += character;
    if (!/\s/.test(character)) lastSignificant = character;
  }
  return repaired;
}

function parseJsonCandidate(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (directError) {
    const repaired = repairMissingJsonCommas(repairJsonStringLiterals(value));
    if (repaired !== value) return JSON.parse(repaired) as unknown;
    throw directError;
  }
}

export function parseModelJson(value: string): unknown {
  const fenced = stripJsonCodeFence(value);
  try {
    return parseJsonCandidate(fenced);
  } catch (directError) {
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw directError instanceof SyntaxError ? directError : new SyntaxError("Model output contained no JSON object.");
    return parseJsonCandidate(fenced.slice(start, end + 1));
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
    "For an Unsupported number error, remove that numeric claim or cite an EvidenceRef containing the exact same number; never substitute a different number.",
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
      if (!raw.trim()) throw new Error("Model returned an empty response.");
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
