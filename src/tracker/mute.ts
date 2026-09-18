const MUTE_KEY = "tracker.muted";

export function readMuted() {
  try { return window.localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

export function writeMuted(value: boolean) {
  try { window.localStorage.setItem(MUTE_KEY, value ? "1" : "0"); } catch { /* storage is optional */ }
}
