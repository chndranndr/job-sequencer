import test from "node:test";
import assert from "node:assert/strict";
import {
  canApproveSampleDocuments,
  canReviseSample,
  canStartSampleRun,
  remainingRevises,
  SAMPLE_DIRECTION_LABELS,
  SAMPLE_READY_REVISE_COPY,
  SAMPLE_REVISION_CAP,
  sampleCvPageWarning,
  sampleDirectionControls,
  sampleReadyReviseRequest,
  sampleStageActions,
  verificationChecks,
} from "../src/tracker/sample.js";

test("SAMPLE exposes the manual stage actions without skipping gates", () => {
  assert.deepEqual(sampleStageActions("Recommended"), ["select", "archive"]);
  assert.deepEqual(sampleStageActions("Discarded"), ["restore-recommended", "archive"]);
  assert.deepEqual(sampleStageActions("Selected"), ["unselect", "generate", "archive"]);
  assert.deepEqual(sampleStageActions("Drafting"), ["revise", "approve", "archive"]);
  assert.deepEqual(sampleStageActions("Ready"), ["revise", "apply", "archive"]);
  assert.deepEqual(sampleStageActions("Applied"), ["phrase", "outcome", "archive"]);
  assert.deepEqual(sampleStageActions("Interview"), ["phrase", "outcome", "archive"]);
  assert.deepEqual(sampleStageActions("Archived"), ["restore"]);
});

test("Selected SAMPLE shows direction controls before generate", () => {
  assert.ok(sampleStageActions("Selected").includes("generate"));
  assert.deepEqual(sampleDirectionControls("Selected"), ["cvLength", "letterMode", "letterNarration"]);
  assert.equal(SAMPLE_DIRECTION_LABELS.cvLength, "CV length");
  assert.equal(SAMPLE_DIRECTION_LABELS.letterMode, "Letter stance");
  assert.equal(SAMPLE_DIRECTION_LABELS.letterNarration, "Narration");
  assert.equal(SAMPLE_DIRECTION_LABELS.cvPagesOverride, "CV pages override");
});

test("complete CV page warning is advisory and only appears below the profile estimate", () => {
  assert.match(sampleCvPageWarning("complete", 2, 3), /Complete profile is estimated at 3 pages/);
  assert.match(sampleCvPageWarning("complete", 2, 3), /2-page target/);
  assert.equal(sampleCvPageWarning("complete", 3, 3), "");
  assert.equal(sampleCvPageWarning("short", 2, 3), "");
  assert.equal(sampleCvPageWarning("complete", null, 3), "");
});

test("Drafting SAMPLE exposes Revise with a correction box", () => {
  assert.ok(sampleStageActions("Drafting").includes("revise"));
  assert.deepEqual(sampleDirectionControls("Drafting"), ["cvLength", "letterMode", "letterNarration", "revisionNotes"]);
  assert.equal(SAMPLE_DIRECTION_LABELS.revisionNotes, "Correction");
  assert.equal(SAMPLE_DIRECTION_LABELS.remainingRevises, "Remaining revises");
  assert.equal(remainingRevises(0), SAMPLE_REVISION_CAP);
});

test("Revise disables when remaining revises is 0", () => {
  assert.equal(remainingRevises(3), 0);
  assert.equal(canReviseSample(3, false, false), false);
  assert.equal(canReviseSample(2, false, false), true);
  assert.equal(canReviseSample(2, true, false), false);
});

test("Ready SAMPLE revise POSTs regenerate and confirm copy names Drafting", () => {
  assert.ok(sampleStageActions("Ready").includes("revise"));
  assert.match(SAMPLE_READY_REVISE_COPY, /Drafting/);
  assert.deepEqual(sampleReadyReviseRequest(), { method: "POST", path: "/api/jobs/:id/regenerate" });
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
