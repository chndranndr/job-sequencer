import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cueForRunStatus, WORKFLOW_CUES } from "../src/workflow-cues.js";

test("workflow cues map run status onto run/success/fail stings", () => {
  assert.equal(cueForRunStatus("running"), "running");
  assert.equal(cueForRunStatus("succeeded"), "succeeded");
  assert.equal(cueForRunStatus("failed"), "failed");
  assert.equal(cueForRunStatus("cancelled"), "failed");
  assert.equal(cueForRunStatus("timed_out"), "failed");
  assert.equal(WORKFLOW_CUES.running, "/audio/workflow-run.mp3");
  assert.equal(WORKFLOW_CUES.succeeded, "/audio/workflow-success.mp3");
  assert.equal(WORKFLOW_CUES.failed, "/audio/workflow-fail.mp3");
});

test("local workflow cue files are present for this machine", () => {
  const dir = fileURLToPath(new URL("../public/audio/", import.meta.url));
  assert.equal(existsSync(`${dir}workflow-run.mp3`), true);
  assert.equal(existsSync(`${dir}workflow-success.mp3`), true);
  assert.equal(existsSync(`${dir}workflow-fail.mp3`), true);
});
