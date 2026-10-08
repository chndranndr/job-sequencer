import { createHash } from "node:crypto";

export type TelemetryMode = "metadata" | "trace" | "redacted" | "debug";

// Trace mode keeps prompts and model text after credential redaction, while tool results stay metadata-only.
export function getTelemetryMode(): TelemetryMode {
  const raw = process.env.TELEMETRY_MODE?.trim().toLowerCase();
  if (!raw) return "trace";
  if (raw === "debug") return "debug";
  if (raw === "redacted") return "redacted";
  if (raw === "trace") return "trace";
  return "metadata";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const maxTelemetryEntries = 100;
const maxTelemetryDepth = 8;
const maxTelemetryTextLength = 2_000_000;
const sensitiveFieldPattern = /(?:^|_)(?:api_key|apikey|token|secret|password|authorization|credential|credentials|cookie|private_key|access_token|bearer|auth|client_secret|refresh_token)(?:_|$)/;

function isSensitiveField(name: string) {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  return sensitiveFieldPattern.test(normalized);
}

function redactedText(value: string, redact: (value: string) => string) {
  return redact(value).slice(0, maxTelemetryTextLength);
}

function metadataValue(value: unknown): unknown {
  if (typeof value === "string") return { textLength: value.length, textHash: sha256(value) };
  if (Array.isArray(value)) return { valueType: "array", itemCount: value.length };
  if (value && typeof value === "object") return { valueType: "object", keys: Object.keys(value).slice(0, maxTelemetryEntries) };
  if (typeof value === "bigint") return `${value}n`;
  return value;
}

function redactValue(value: unknown, redact: (value: string) => string, seen = new WeakSet<object>(), depth = 0, fieldName = ""): unknown {
  if (isSensitiveField(fieldName)) return "[redacted]";
  if (typeof value === "string") return redactedText(value, redact);
  if (typeof value === "bigint") return `${value}n`;
  if (!value || typeof value !== "object") return value;
  if (depth >= maxTelemetryDepth || seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, maxTelemetryEntries).map(item => redactValue(item, redact, seen, depth + 1, fieldName));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxTelemetryEntries)
      .map(([key, current]) => [key, redactValue(current, redact, seen, depth + 1, key)]),
  );
}

export function telemetryPromptPayload(text: string, redact: (value: string) => string) {
  const mode = getTelemetryMode();
  if (mode !== "metadata") return { text: redactedText(text, redact) };
  return { textLength: text.length, promptHash: sha256(text) };
}

export function telemetryAssistantPayload(payload: Record<string, unknown>, redact: (value: string) => string) {
  const mode = getTelemetryMode();
  if (mode !== "metadata") {
    return typeof payload.text === "string" ? { ...payload, text: redactedText(payload.text, redact) } : payload;
  }
  const text = typeof payload.text === "string" ? payload.text : "";
  return {
    textLength: text.length,
    textHash: text ? sha256(text) : null,
    provider: payload.provider ?? null,
    model: payload.model ?? null,
    stopReason: payload.stopReason ?? null,
    error: payload.error ?? null,
    usage: payload.usage ?? null,
  };
}

export function telemetrySystemPromptPayload(text: string, redact: (value: string) => string) {
  const mode = getTelemetryMode();
  if (mode !== "metadata") return { text: redactedText(text, redact) };
  return { textLength: text.length, promptHash: sha256(text) };
}

export function telemetryToolPayload(payload: Record<string, unknown>, redact: (value: string) => string) {
  const mode = getTelemetryMode();
  if (mode === "metadata" || mode === "trace") {
    return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
      key,
      key === "toolCallId" || key === "toolName"
        ? (typeof value === "string" ? value.slice(0, 200) : metadataValue(value))
        : mode === "trace" && key === "args"
          ? redactValue(value, redact)
          : metadataValue(value),
    ]));
  }
  return redactValue(payload, redact);
}
