import test from "node:test";
import assert from "node:assert/strict";
import {
  completeMergedFromMapped,
  detectIdentityConflict,
  extractProfileText,
  isEmptyProfileBank,
  mergeResumeIntoProfile,
  normalizeResumeProfile,
  parseResumeText,
  ProfileImportError,
  profileDisplayName,
} from "../src/server/profile-import.js";
import type { PiSessionLike } from "../src/server/pi.js";
import { createEmptyProfile, type StructuredProfile } from "../src/shared.js";

const settings = { provider: "job-sequencer-faux", model: "phase0", source: "freehire" as const, scoreThreshold: 60, maxResults: 50, cvPages: 2, coverLetterPages: 1 };

class FakeSession implements PiSessionLike {
  constructor(private readonly payload: unknown) {}
  private listener: ((event: unknown) => void) | null = null;
  subscribe(listener: (event: unknown) => void) { this.listener = listener; return () => { this.listener = null; }; }
  async prompt() {
    const delta = typeof this.payload === "string" ? this.payload : JSON.stringify(this.payload);
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
  }
  async abort() {}
  dispose() {}
}

function namedProfile(firstName: string, lastName = "", email = ""): StructuredProfile {
  const profile = createEmptyProfile();
  profile.identity.firstName = firstName;
  profile.identity.lastName = lastName;
  profile.identity.email = email;
  return profile;
}

test("resume profile normalization creates safe IDs and schema-compatible dates", () => {
  const profile = normalizeResumeProfile({ experience: [{ title: "Engineer", startMonth: "2023-7", currentRole: "present" }, { title: "Engineer", startMonth: "bad" }], skills: ["TypeScript", { name: "React" }] });
  assert.equal(profile.experience[0]?.startMonth, "2023-07");
  assert.equal(profile.experience[0]?.startYear, "2023");
  assert.equal(profile.experience[1]?.startMonth, "");
  assert.equal(profile.experience[0]?.currentRole, true);
  assert.equal(new Set(profile.experience.map((entry) => entry.id)).size, 2);
  assert.deepEqual(profile.skills.map((entry) => entry.name), ["TypeScript", "React"]);
});

test("resume experience normalization keeps year-only dates and derives year from month", () => {
  const profile = normalizeResumeProfile({ experience: [
    { title: "Engineer", company: "Example", startYear: "2021", endYear: "2023" },
    { title: "Lead", company: "Other", startMonth: "2024-03", endMonth: "2025-11" },
  ] });
  assert.deepEqual(profile.experience.map(({ id: _id, ...entry }) => entry), [
    { title: "Engineer", company: "Example", employmentType: "", location: "", startMonth: "", startYear: "2021", endMonth: "", endYear: "2023", currentRole: false, description: "" },
    { title: "Lead", company: "Other", employmentType: "", location: "", startMonth: "2024-03", startYear: "2024", endMonth: "2025-11", endYear: "2025", currentRole: false, description: "" },
  ]);
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
  const profile = await parseResumeText("Candidate Engineer TypeScript", settings, async () => new FakeSession({
    identity: { firstName: "Candidate", email: "candidate@example.test" },
    experience: [{ title: "Engineer", company: "Example", startMonth: "2023-7", currentRole: true, description: "Built APIs" }],
    skills: ["TypeScript", { name: "React" }],
  }));
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

test("empty or unnamed banks are never identity conflicts", () => {
  const incoming = namedProfile("Ada", "Lovelace", "ada@example.test");
  assert.equal(isEmptyProfileBank(createEmptyProfile()), true);
  assert.equal(isEmptyProfileBank(null), true);
  assert.equal(detectIdentityConflict(createEmptyProfile(), incoming).conflict, false);
  assert.equal(detectIdentityConflict(null, incoming).conflict, false);
  assert.equal(detectIdentityConflict(namedProfile("Ada", "Lovelace", "ada@example.test"), incoming).conflict, false);
});

test("disagreeing name or email marks an identity conflict", () => {
  const current = namedProfile("Ada", "Lovelace", "ada@example.test");
  const nameClash = detectIdentityConflict(current, namedProfile("Grace", "Hopper", "ada@example.test"));
  assert.equal(nameClash.conflict, true);
  assert.match(nameClash.reason, /name/);
  assert.equal(nameClash.currentName, "Ada Lovelace");
  assert.equal(nameClash.incomingName, "Grace Hopper");

  const emailClash = detectIdentityConflict(current, namedProfile("Ada", "Lovelace", "grace@example.test"));
  assert.equal(emailClash.conflict, true);
  assert.match(emailClash.reason, /email/);
});

test("Pi merge keeps omitted facts and can add a new role", async () => {
  const current = namedProfile("Ada", "Lovelace", "ada@example.test");
  current.identity.summary = "Kept summary";
  current.experience = [{
    id: "exp-1",
    title: "Analyst",
    company: "Analytical Engines",
    employmentType: "",
    location: "",
    startMonth: "2020-01",
    startYear: "2020",
    endMonth: "",
    endYear: "",
    currentRole: false,
    description: "Kept role",
  }];
  current.skills = [{ id: "sk-1", name: "Mathematics" }];

  const merged = await mergeResumeIntoProfile("resume text", current, settings, async () => new FakeSession({
    identity: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", summary: "Kept summary" },
    experience: [
      {
        id: "exp-1",
        title: "Analyst",
        company: "Analytical Engines",
        startMonth: "2020-01",
        startYear: "2020",
        endMonth: "2021-06",
        endYear: "2021",
        description: "Kept role",
      },
      {
        id: "exp-2",
        title: "Engineer",
        company: "Difference Co",
        startMonth: "2023-07",
        startYear: "2023",
        currentRole: true,
        description: "New role",
      },
    ],
    skills: [{ name: "Mathematics" }, { name: "Fortran" }],
  }));

  assert.equal(merged.identity.summary, "Kept summary");
  assert.equal(merged.experience.length, 2);
  assert.equal(merged.experience[0]?.id, "exp-1");
  assert.equal(merged.experience[0]?.endMonth, "2021-06");
  assert.equal(merged.experience.some((entry) => entry.title === "Engineer" && entry.company === "Difference Co"), true);
  assert.deepEqual(merged.skills.map((entry) => entry.name).sort(), ["Fortran", "Mathematics"]);
});

test("completeMergedFromMapped fills dates and upgrades summarized descriptions from map step", () => {
  const current = namedProfile("Chandra", "Anindra", "chandra@example.test");
  current.experience = [{
    id: "exp-alex",
    title: "Full Stack Engineer (Data & AI)",
    company: "Alex Solutions",
    employmentType: "",
    location: "",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    currentRole: false,
    description: "Short summary paragraph.",
  }];

  const mapped = namedProfile("Chandra", "Anindra", "chandra@example.test");
  mapped.experience = [{
    id: "mapped-alex",
    title: "Full Stack Engineer (Data & AI)",
    company: "Alex Solutions",
    employmentType: "",
    location: "",
    startMonth: "2025-08",
    startYear: "2025",
    endMonth: "2026-07",
    endYear: "2026",
    currentRole: false,
    description: "Bullet one.\nBullet two.\nBullet three.\nBullet four.\nBullet five.\nBullet six.\nBullet seven.",
  }];

  const merged = completeMergedFromMapped(current, mapped);
  assert.equal(merged.experience[0]?.id, "exp-alex");
  assert.equal(merged.experience[0]?.startMonth, "2025-08");
  assert.equal(merged.experience[0]?.endMonth, "2026-07");
  assert.equal(merged.experience[0]?.description.split("\n").length, 7);
});

test("Pi merge fills empty dates and replaces summarized descriptions with resume bullets", async () => {
  const current = namedProfile("Chandra", "Anindra", "chandra@example.test");
  current.experience = [{
    id: "exp-alex",
    title: "Full Stack Engineer (Data & AI)",
    company: "Alex Solutions",
    employmentType: "",
    location: "",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    currentRole: false,
    description: "Short summary paragraph.",
  }];

  const mapped = namedProfile("Chandra", "Anindra", "chandra@example.test");
  mapped.experience = [{
    id: "mapped-alex",
    title: "Full Stack Engineer (Data & AI)",
    company: "Alex Solutions",
    employmentType: "",
    location: "",
    startMonth: "2025-08",
    startYear: "2025",
    endMonth: "2026-07",
    endYear: "2026",
    currentRole: false,
    description: "Bullet one.\nBullet two.\nBullet three.\nBullet four.\nBullet five.\nBullet six.\nBullet seven.",
  }];

  const merged = await mergeResumeIntoProfile("Alex Solutions Aug 2025–Jul 2026 bullets", current, settings, async () => new FakeSession({
    identity: { firstName: "Chandra", lastName: "Anindra", email: "chandra@example.test" },
    experience: [{
      id: "exp-alex",
      title: "Full Stack Engineer (Data & AI)",
      company: "Alex Solutions",
      description: "Short summary paragraph.",
    }],
  }), mapped);

  assert.equal(merged.experience[0]?.id, "exp-alex");
  assert.equal(merged.experience[0]?.startMonth, "2025-08");
  assert.equal(merged.experience[0]?.endMonth, "2026-07");
  assert.match(merged.experience[0]?.description ?? "", /Bullet seven/);
  assert.equal(merged.experience[0]?.description.split("\n").length, 7);
});

test("resume month normalization accepts month names", () => {
  const profile = normalizeResumeProfile({ experience: [{ title: "Engineer", startMonth: "Aug 2025", endMonth: "Jul 2026" }] });
  assert.equal(profile.experience[0]?.startMonth, "2025-08");
  assert.equal(profile.experience[0]?.endMonth, "2026-07");
});

test("identity conflict keeps the bank and exposes extracted-only replace payload", async () => {
  const current = namedProfile("Ada", "Lovelace", "ada@example.test");
  current.identity.summary = "Bank summary";
  const extracted = await parseResumeText("Grace Hopper", settings, async () => new FakeSession({
    identity: { firstName: "Grace", lastName: "Hopper", email: "grace@example.test", summary: "CV summary" },
    experience: [{ title: "Admiral", company: "Navy", startMonth: "2021-01" }],
  }));
  const identity = detectIdentityConflict(current, extracted);
  assert.equal(identity.conflict, true);
  assert.equal(identity.currentName, "Ada Lovelace");
  assert.equal(identity.incomingName, "Grace Hopper");
  // On conflict the run summary profile is extracted-only; UI must not apply until Replace.
  const summaryProfile = identity.conflict ? extracted : current;
  assert.equal(summaryProfile.identity.firstName, "Grace");
  assert.equal(summaryProfile.identity.summary, "CV summary");
  assert.notEqual(current.identity.summary, summaryProfile.identity.summary);
});

test("empty bank import stays extract-only", async () => {
  let prompts = 0;
  const mapped = await parseResumeText("Candidate", settings, async () => {
    prompts += 1;
    return new FakeSession({
      identity: { firstName: "Candidate", email: "candidate@example.test" },
    });
  });
  const bank = createEmptyProfile();
  const identity = detectIdentityConflict(bank, mapped);
  assert.equal(identity.conflict, false);
  assert.equal(isEmptyProfileBank(bank), true);
  assert.equal(prompts, 1);
  assert.equal(mapped.identity.firstName, "Candidate");
  assert.equal(profileDisplayName(mapped), "Candidate");
});

test("invalid Pi JSON is repaired on a second attempt", async () => {
  let calls = 0;
  const profile = await parseResumeText("Candidate Engineer", settings, async () => {
    calls += 1;
    if (calls === 1) return new FakeSession("Here is JSON that is not valid.");
    return new FakeSession({
      identity: { firstName: "Candidate", email: "candidate@example.test" },
      experience: [{ title: "Engineer", company: "Example", startMonth: "2023-07" }],
    });
  });
  assert.equal(calls, 2);
  assert.equal(profile.identity.firstName, "Candidate");
  assert.equal(profile.experience[0]?.company, "Example");
});
