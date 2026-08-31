import assert from "node:assert/strict";
import test from "node:test";
import type { Run } from "../src/shared.js";
import { coalesceObservedRun } from "../src/tracker/observe-run.js";
import { shouldRefreshActiveRun } from "../src/tracker/visibility.js";

test("active-run refresh requires a visible and focused document", () => {
  assert.equal(shouldRefreshActiveRun("visible", true), true);
  assert.equal(shouldRefreshActiveRun("visible", false), false);
  assert.equal(shouldRefreshActiveRun("hidden", true), false);
  assert.equal(shouldRefreshActiveRun("prerender" as DocumentVisibilityState, true), false);
});

function runStub(status: Run["status"], summary: unknown = null): Run {
  return {
    id: "run-import",
    workflow: "profile_import",
    status,
    provider: "fixture",
    model: "test",
    summary,
    started_at: "2026-08-31T03:32:40.225Z",
  };
}

test("active-run poller loads the terminal run instead of dropping a just-finished import", async () => {
  const terminal = runStub("succeeded", { profile: { identity: { firstName: "Chandra" } }, extracted: {}, source: { fileName: "cv.pdf" }, identity: { conflict: false } });
  const next = await coalesceObservedRun({
    active: null,
    currentId: "run-import",
    load: async (id) => {
      assert.equal(id, "run-import");
      return terminal;
    },
  });
  assert.equal(next?.status, "succeeded");
  assert.equal((next?.summary as { source?: { fileName?: string } })?.source?.fileName, "cv.pdf");
});

test("active-run poller still clears when no current run is tracked", async () => {
  const next = await coalesceObservedRun({
    active: null,
    currentId: null,
    load: async () => {
      throw new Error("load must not run when currentId is empty");
    },
  });
  assert.equal(next, null);
});
