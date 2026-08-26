import test from "node:test";
import assert from "node:assert/strict";
import { canApproveSampleDocuments, canStartSampleRun, sampleStageActions, verificationChecks } from "../src/tracker/sample.js";

test("SAMPLE exposes the manual stage actions without skipping gates", () => {
  assert.deepEqual(sampleStageActions("Recommended"), ["select", "archive"]);
  assert.deepEqual(sampleStageActions("Discarded"), ["restore-recommended", "archive"]);
  assert.deepEqual(sampleStageActions("Selected"), ["unselect", "generate", "archive"]);
  assert.deepEqual(sampleStageActions("Drafting"), ["regenerate", "approve", "archive"]);
  assert.deepEqual(sampleStageActions("Ready"), ["apply", "archive"]);
  assert.deepEqual(sampleStageActions("Applied"), ["phrase", "outcome", "archive"]);
  assert.deepEqual(sampleStageActions("Interview"), ["phrase", "outcome", "archive"]);
  assert.deepEqual(sampleStageActions("Archived"), ["restore"]);
});

test("SAMPLE run starts stop at the global or local in-flight gate", () => {
  assert.equal(canStartSampleRun(false, false), true);
  assert.equal(canStartSampleRun(true, false), false);
  assert.equal(canStartSampleRun(false, true), false);
});

test("SAMPLE approval requires successful verification and renders every verification field", () => {
  assert.equal(canApproveSampleDocuments(null), false);
  assert.equal(canApproveSampleDocuments({ success: false } as never), false);
  assert.equal(canApproveSampleDocuments({ success: true } as never), true);

  const checks = verificationChecks({
    success: true,
    cvPages: 2,
    coverLetterPages: 1,
    cvTextPresent: true,
    coverLetterTextPresent: true,
    emailPresent: true,
    phonePresent: true,
    checkedAt: "2026-08-24T00:00:00.000Z",
  });
  assert.deepEqual(checks.map((check) => check.key), ["success", "cvPages", "coverLetterPages", "cvTextPresent", "coverLetterTextPresent", "emailPresent", "phonePresent", "checkedAt"]);
  assert.ok(checks.slice(0, 7).every((check) => check.pass));
  assert.equal(checks.at(-1)?.value, "2026-08-24T00:00:00.000Z");
});
