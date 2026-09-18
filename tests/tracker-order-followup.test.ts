import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../src/shared.js";
import { filterOrderJobs, orderRowSummary, orderSlots, orderSlotJobs } from "../src/tracker/order.js";
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

test("ORDER board leads with RECO and puts CUT last", () => {
  assert.deepEqual(orderSlots.map((slot) => slot.pos), ["B00", "B01", "B02", "B03", "B04", "B05", "B06", "B07"]);
  assert.deepEqual(orderSlots.map((slot) => slot.key), ["Recommended", "Selected", "Drafting", "Ready", "Applied", "Interview", "Outcomes", "Discarded"]);

  const jobs = [job("Recommended", "Acme"), job("Discarded", "Northstar"), job("Selected", "Redwood")];
  assert.deepEqual(orderSlotJobs(jobs, "Recommended").map((item) => item.company), ["Acme"]);
  assert.deepEqual(orderSlotJobs(jobs, "Discarded").map((item) => item.company), ["Northstar"]);
  assert.deepEqual(filterOrderJobs(jobs, "", "Recommended"), [jobs[0]]);
});

test("ORDER rows sort by name, created, updated, and keep fit-desc as the default", () => {
  const dated = (company: string, score: number, firstSeenAt: string, updatedAt: string) =>
    ({ ...job("Recommended", company), score, first_seen_at: firstSeenAt, updated_at: updatedAt }) as Job;
  const jobs = [
    dated("Zeta", 90, "2026-01-03T00:00:00.000Z", "2026-02-01T00:00:00.000Z"),
    dated("acme", 70, "2026-01-01T00:00:00.000Z", "2026-02-03T00:00:00.000Z"),
    dated("Nova", 80, "2026-01-02T00:00:00.000Z", "2026-02-02T00:00:00.000Z"),
  ];

  // Default is the existing fit-desc behavior.
  assert.deepEqual(orderSlotJobs(jobs, "Recommended").map((item) => item.company), ["Zeta", "Nova", "acme"]);
  assert.deepEqual(orderSlotJobs(jobs, "Recommended", { key: "fit", dir: "asc" }).map((item) => item.company), ["acme", "Nova", "Zeta"]);
  // Name is case-insensitive: "acme" sorts before "Nova" despite the lowercase first letter.
  assert.deepEqual(orderSlotJobs(jobs, "Recommended", { key: "name", dir: "asc" }).map((item) => item.company), ["acme", "Nova", "Zeta"]);
  assert.deepEqual(orderSlotJobs(jobs, "Recommended", { key: "name", dir: "desc" }).map((item) => item.company), ["Zeta", "Nova", "acme"]);
  assert.deepEqual(orderSlotJobs(jobs, "Recommended", { key: "created", dir: "asc" }).map((item) => item.company), ["acme", "Nova", "Zeta"]);
  assert.deepEqual(orderSlotJobs(jobs, "Recommended", { key: "created", dir: "desc" }).map((item) => item.company), ["Zeta", "Nova", "acme"]);
  assert.deepEqual(orderSlotJobs(jobs, "Recommended", { key: "updated", dir: "asc" }).map((item) => item.company), ["Zeta", "Nova", "acme"]);
  assert.deepEqual(orderSlotJobs(jobs, "Recommended", { key: "updated", dir: "desc" }).map((item) => item.company), ["acme", "Nova", "Zeta"]);
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
