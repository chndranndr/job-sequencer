import test from "node:test";
import assert from "node:assert/strict";
import { formatTapeTime, sanitizeTrackName } from "../src/tracker/tape-store.js";

test("sanitizeTrackName strips mp3 extension and falls back safely", () => {
  assert.equal(sanitizeTrackName("night-run.mp3"), "night-run");
  assert.equal(sanitizeTrackName("  spaced  .MP3  "), "spaced");
  assert.equal(sanitizeTrackName(".mp3"), "Untitled track");
});

test("formatTapeTime renders mm:ss", () => {
  assert.equal(formatTapeTime(0), "0:00");
  assert.equal(formatTapeTime(65), "1:05");
  assert.equal(formatTapeTime(Number.NaN), "0:00");
});
