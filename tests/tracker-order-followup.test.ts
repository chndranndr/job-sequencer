import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../src/shared.js";
import { filterOrderJobs, orderRowSummary, orderSlotJobs } from "../src/tracker/order.js";
import { followUpActionState, isFollowUpEligible } from "../src/tracker/follow-up.js";

function job(stage: Job["stage"], company: string) {
  return { id: `${stage}-${company}`, stage, company, role: "Backend Engineer", location: "Jakarta", source: "manual", score: 80 } as Job;
}

test("ORDER filtering searches row metadata and keeps outcome/archive rows reachable", () => {
  const jobs = [job("Selected", "Acme"), job("Offer", "Northstar"), job("Rejected", "Redwood"), job("Archived", "Old Co")];

  assert.deepEqual(filterOrderJobs(jobs, "north"), [jobs[1]]);
  assert.deepEqual(filterOrderJobs(jobs, "archived"), [jobs[3]]);
  assert.deepEqual(orderSlotJobs(jobs, "Outcomes").map((item) => item.stage), ["Offer", "Rejected", "Archived"]);
});

test("ORDER row summary is stage, fit, and signal", () => {
  const item = {
    ...job("Ready", "Northstar"),
    score: 91,
    posting: "AWS cloud services",
    rank: { reason: "fit", strengths: [], gaps: [] },
  } as Job;
  assert.deepEqual(orderRowSummary(item), { stage: "Ready", fit: 91, signal: "CLOUD" });
});

test("FOLLOW controls honor eligibility, the shared active run, and saved-draft confirmation", () => {
  const applied = job("Applied", "Acme");
  const selected = job("Selected", "Acme");

  assert.equal(isFollowUpEligible(applied), true);
  assert.equal(isFollowUpEligible(selected), false);
  assert.equal(followUpActionState({ job: applied, run: { workflow: "follow_up", status: "running" }, draft: "old", dirty: false }).canDraft, false);
  assert.equal(followUpActionState({ job: applied, run: null, draft: "edited", dirty: true }).canMarkSent, false);
  assert.equal(followUpActionState({ job: applied, run: null, draft: "saved", dirty: false }).canMarkSent, true);
});
