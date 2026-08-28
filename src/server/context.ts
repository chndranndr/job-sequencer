// ponytail: external prompt projections use bounded fields; add token-aware packing after provider context limits are measured.
const maxPromptFieldLength = 40_000;
const maxPromptCollectionEntries = 100;
const truncatedMarker = "\n[truncated]";

const controlCharPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const zeroWidthPattern = /[\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

export function normalizePromptText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(controlCharPattern, "")
    .replace(zeroWidthPattern, "");
}

export function projectPromptText(value: string, limit = maxPromptFieldLength) {
  const safeLimit = Number.isFinite(limit)
    ? Math.min(maxPromptFieldLength, Math.max(0, Math.floor(limit)))
    : maxPromptFieldLength;
  const normalized = normalizePromptText(value);
  if (normalized.length <= safeLimit) return normalized;
  if (safeLimit <= truncatedMarker.length) return truncatedMarker.slice(0, safeLimit);
  return `${normalized.slice(0, safeLimit - truncatedMarker.length)}${truncatedMarker}`;
}

function projectPromptValue(value: unknown): unknown {
  if (typeof value === "string") return projectPromptText(value);
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.slice(0, maxPromptCollectionEntries).map(projectPromptValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .slice(0, maxPromptCollectionEntries)
        .map(([key, current]) => [projectPromptText(key), projectPromptValue(current)]),
    );
  }
  return value;
}

export function projectPromptContext(value: unknown) {
  return projectPromptValue(value);
}

function sectionLabel(value: string) {
  const normalized = normalizePromptText(value).replace(/\s+/g, " ").trim();
  return normalized.slice(0, 200) || "DATA";
}

function section(kind: "TRUSTED" | "UNTRUSTED", label: string, body: string) {
  const safeLabel = sectionLabel(label);
  const projected = projectPromptText(body).replace(/^[ \t]*---[ \t]*$/gm, "[separator]");
  return [`${kind} ${safeLabel}`, "---", projected, "---"].join("\n");
}

export function trustedSection(label: string, body: string) {
  return section("TRUSTED", label, body);
}

export function untrustedSection(label: string, body: string) {
  return section("UNTRUSTED", label, body);
}

// ponytail: injection detection is advisory; deterministic boundaries remain the security gate.
const injectionPatterns: Array<[string, RegExp]> = [
  ["ignore_previous_instructions", /ignore\s+(all\s+)?previous\s+instructions/i],
  ["reveal_system_prompt", /reveal\s+(the\s+)?system\s+prompt/i],
  ["call_tool", /\bcall\s+a\s+tool\b/i],
  ["change_score", /change\s+(candidate\s+)?score/i],
];

export function detectInjectionSignals(text: string) {
  const normalized = normalizePromptText(text);
  return injectionPatterns.filter(([, pattern]) => pattern.test(normalized)).map(([signal]) => signal);
}
