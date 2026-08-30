export const NARROW_LAYOUT_MQ = "(max-width: 899px)";

export function isNarrowLayout() {
  return typeof window !== "undefined" && window.matchMedia(NARROW_LAYOUT_MQ).matches;
}
