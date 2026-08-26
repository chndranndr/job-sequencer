export function shouldRefreshActiveRun(visibilityState: DocumentVisibilityState, focused: boolean): boolean {
  return visibilityState === "visible" && focused;
}
