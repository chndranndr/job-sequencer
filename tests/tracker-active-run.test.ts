import assert from "node:assert/strict";
import test from "node:test";
import { shouldRefreshActiveRun } from "../src/tracker/visibility.js";

test("active-run refresh requires a visible and focused document", () => {
  assert.equal(shouldRefreshActiveRun("visible", true), true);
  assert.equal(shouldRefreshActiveRun("visible", false), false);
  assert.equal(shouldRefreshActiveRun("hidden", true), false);
  assert.equal(shouldRefreshActiveRun("prerender" as DocumentVisibilityState, true), false);
});
