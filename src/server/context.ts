// ponytail: external prompt projections use bounded fields; add token-aware packing after provider context limits are measured.
const maxPromptFieldLength = 40_000;
const maxPromptCollectionEntries = 100;
const truncatedMarker = "\n[truncated]";

export function projectPromptText(value: string, limit = maxPromptFieldLength) {
  if (value.length <= limit) return value;
  if (limit <= truncatedMarker.length) return truncatedMarker.slice(0, limit);
  return `${value.slice(0, limit - truncatedMarker.length)}${truncatedMarker}`;
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
        .map(([key, current]) => [key, projectPromptValue(current)]),
    );
  }
  return value;
}

export function projectPromptContext(value: unknown) {
  return projectPromptValue(value);
}
