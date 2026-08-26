import test from "node:test";
import assert from "node:assert/strict";
import { extractProfileText, normalizeResumeProfile, parseResumeText, ProfileImportError } from "../src/server/profile-import.js";
import type { PiSessionLike } from "../src/server/pi.js";

const settings = { provider: "personal-job-search-faux", model: "phase0", source: "freehire" as const, scoreThreshold: 60, maxResults: 50, cvPages: 2, coverLetterPages: 1 };

class FakeSession implements PiSessionLike {
  private listener: ((event: unknown) => void) | null = null;
  subscribe(listener: (event: unknown) => void) { this.listener = listener; return () => { this.listener = null; }; }
  async prompt() { this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: JSON.stringify({ identity: { firstName: "Candidate", email: "candidate@example.test" }, experience: [{ title: "Engineer", company: "Example", startMonth: "2023-7", currentRole: true, description: "Built APIs" }], skills: ["TypeScript", { name: "React" }] }) } }); }
  async abort() {}
  dispose() {}
}

test("resume profile normalization creates safe IDs and schema-compatible dates", () => {
  const profile = normalizeResumeProfile({ experience: [{ title: "Engineer", startMonth: "2023-7", currentRole: "present" }, { title: "Engineer", startMonth: "bad" }], skills: ["TypeScript", { name: "React" }] });
  assert.equal(profile.experience[0]?.startMonth, "2023-07");
  assert.equal(profile.experience[1]?.startMonth, "");
  assert.equal(profile.experience[0]?.currentRole, true);
  assert.equal(new Set(profile.experience.map((entry) => entry.id)).size, 2);
  assert.deepEqual(profile.skills.map((entry) => entry.name), ["TypeScript", "React"]);
});

test("resume education normalization emits month, year fallback, and GPA fields", () => {
  const profile = normalizeResumeProfile({ education: [
    { institution: "Example University", degree: "BSc", fieldOfStudy: "Computer Science", startMonth: "2020-9", endMonth: "2024-06", gpa: "3.8/4.0", description: "ignored" },
    { institution: "Older University", degree: "Diploma", startMonth: "2016", endMonth: "2019", gpa: "" },
  ] });
  assert.deepEqual(profile.education.map(({ id: _id, ...entry }) => entry), [
    { institution: "Example University", degree: "BSc", fieldOfStudy: "Computer Science", startMonth: "2020-09", startYear: "2020", endMonth: "2024-06", endYear: "2024", gpa: "3.8/4.0" },
    { institution: "Older University", degree: "Diploma", fieldOfStudy: "", startMonth: "", startYear: "2016", endMonth: "", endYear: "2019", gpa: "" },
  ]);
  assert.equal("description" in profile.education[0]!, false);
  assert.equal("expectedGraduation" in profile.education[0]!, false);
});

test("Pi resume parsing accepts JSON deltas and returns a structured draft", async () => {
  const profile = await parseResumeText("Candidate Engineer TypeScript", settings, async () => new FakeSession());
  assert.equal(profile.identity.firstName, "Candidate");
  assert.equal(profile.identity.email, "candidate@example.test");
  assert.equal(profile.experience[0]?.startMonth, "2023-07");
  assert.equal(profile.experience[0]?.currentRole, true);
  assert.deepEqual(profile.skills.map((entry) => entry.name), ["TypeScript", "React"]);
});

test("resume extraction rejects unsupported and empty uploads", async () => {
  await assert.rejects(extractProfileText({ filename: "resume.txt", mimetype: "text/plain", buffer: Buffer.from("resume") }), ProfileImportError);
  await assert.rejects(extractProfileText({ filename: "resume.pdf", mimetype: "application/pdf", buffer: Buffer.alloc(0) }), ProfileImportError);
});
