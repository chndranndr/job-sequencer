import { createHash } from "node:crypto";

export type TelemetryMode = "metadata" | "redacted" | "debug";

// ponytail: default telemetry stores metadata and bounded excerpts; full payload requires explicit local debug mode.
export function getTelemetryMode(): TelemetryMode {
  const raw = process.env.TELEMETRY_MODE?.trim().toLowerCase();
  if (raw === "debug") return "debug";
  if (raw === "redacted") return "redacted";
  return "metadata";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function telemetryPromptPayload(text: string, redact: (value: string) => string) {
  const mode = getTelemetryMode();
  if (mode === "debug") return { text: redact(text) };
  if (mode === "redacted") return { text: redact(text) };
  return { textLength: text.length, promptHash: sha256(text) };
}

export function telemetryAssistantPayload(payload: Record<string, unknown>, redact: (value: string) => string) {
  const mode = getTelemetryMode();
  if (mode === "debug" || mode === "redacted") return payload;
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
  if (mode === "debug") return { text: redact(text) };
  if (mode === "redacted") return { text: redact(text) };
  return { textLength: text.length, promptHash: sha256(text) };
}
