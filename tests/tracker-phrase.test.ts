import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../src/shared.js";
import { filterPhraseJobs, phraseActionState } from "../src/tracker/phrase.js";

function job(stage: Job["stage"], company: string, role: string, location = "Jakarta") {
  return { id: `${stage}-${company}-${role}`, stage, company, role, location, score: 80 } as Job;
}

test("PHRASE eligibility filters stage first, then searches company and role", () => {
  const applied = job("Applied", "Acme", "Backend Engineer");
  const interview = job("Interview", "Northstar", "Java Platform Engineer");
  const recommended = job("Recommended", "Acme", "Backend Engineer");
  const offer = job("Offer", "Acme", "Java Platform Engineer");

  assert.deepEqual(filterPhraseJobs([applied, interview, recommended, offer], "acme"), [applied]);
  assert.deepEqual(filterPhraseJobs([applied, interview, recommended, offer], "java", "Interview"), [interview]);
  assert.deepEqual(filterPhraseJobs([applied, interview, recommended, offer], "jakarta"), []);
  assert.deepEqual(filterPhraseJobs([applied, interview, recommended, offer], "", "Applied"), [applied]);
});

test("PHRASE notes and reset actions respect dirty, busy, active-run, and empty-chat state", () => {
  assert.deepEqual(phraseActionState({ notes: "new", savedNotes: "old", messageCount: 2, runActive: false, busy: false }), {
    dirty: true,
    canSaveNotes: true,
    canResetChat: true,
  });
  assert.deepEqual(phraseActionState({ notes: "old", savedNotes: "old", messageCount: 2, runActive: true, busy: false }), {
    dirty: false,
    canSaveNotes: false,
    canResetChat: false,
  });
  assert.equal(phraseActionState({ notes: "new", savedNotes: "old", messageCount: 0, runActive: false, busy: false }).canResetChat, false);
  assert.equal(phraseActionState({ notes: "new", savedNotes: "old", messageCount: 2, runActive: false, busy: true }).canSaveNotes, false);
});
