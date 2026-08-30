import test from "node:test";
import assert from "node:assert/strict";
import type { Job, JobStage } from "../src/shared.js";
import { channelJobCount, channelLedState } from "../src/tracker/workflow.js";

function job(stage: JobStage): Job {
  return {
    id: stage,
    source_id: stage,
    source: "freehire",
    url: `https://example.test/${stage}`,
    company: "Example",
    role: "Engineer",
    location: "Remote",
    posting: "Posting",
    score: 80,
    stage,
    rank: { reason: "fit", strengths: [], gaps: [] },
    notes: "",
    first_seen_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
  };
}

test("channelJobCount phrase counts Applied and Interview like phrase eligibility", () => {
  const jobs = [job("Applied"), job("Interview"), job("Ready"), job("Selected")];
  assert.equal(channelJobCount("phrase", jobs), 2);
  assert.equal(channelJobCount("follow", jobs), 2);
  assert.equal(channelJobCount("apply", jobs), 1);
  assert.equal(channelJobCount("select", jobs), 1);
});

test("channelLedState uses active green, inactive orange when count, else dim", () => {
  assert.equal(channelLedState(true, 0), "g");
  assert.equal(channelLedState(true, 3), "g");
  assert.equal(channelLedState(false, 2), "o");
  assert.equal(channelLedState(false, 0), "dim");
});
