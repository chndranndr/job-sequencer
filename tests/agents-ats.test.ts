import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyProfile } from "../src/shared.js";
import { buildEvidenceBank } from "../src/server/agents/evidence.js";
import { runAtsReviewer } from "../src/server/agents/ats.js";
import { AtsReviewSchema, type ApplicationStrategy, type CVDocument } from "../src/server/agents/types.js";
import { deterministicAtsChecks, type CommandRunner } from "../src/server/documents.js";
import { generateJob } from "../src/server/generation.js";
import { defaultSettings } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import { atsFixture } from "./evals/ats.eval.js";

function fixture() {
  const profile = createEmptyProfile();
  Object.assign(profile.identity, { email: "ada@example.test", phone: "+1 555 0100" });
  profile.experience = [{ id: "exp", title: "Engineer", company: "Example Labs", employmentType: "Full-time", location: "Remote", startMonth: "2024-01", startYear: "2024", endMonth: "", endYear: "", currentRole: true, description: "Built Java services." }];
  profile.skills = [{ id: "java", name: "Java" }];
  const bank = buildEvidenceBank(profile);
  const ref = bank.items.find(item => item.ref === "skill:java")!.ref;
  const strategy: ApplicationStrategy = { positioning: "Engineer", targetRole: "Engineer", primarySellingPoints: [{ angle: "Java", evidenceRefs: [ref] }], requirements: [{ requirement: "Java", importance: "critical", candidateFit: "strong", evidenceRefs: [ref] }], narrativeGuidance: [], deEmphasize: [], genuineGaps: [], rankDisagreements: [] };
  const document: CVDocument = { summary: { text: "Engineer", evidenceRefs: [ref] }, experiences: [{ experienceId: "exp", bullets: [{ text: "Built Java services.", evidenceRefs: ["experience:exp:bullet:0" as typeof ref], transformation: "rewrite" }] }], skillIds: [], projects: [], coverLetter: { subject: "Engineer", paragraphs: [] } };
  return { profile, bank, strategy, document };
}

test("ATS distinguishes supported omissions from genuine gaps", async () => {
  const { profile, bank, strategy, document } = fixture();
  const expected = atsFixture(bank, document);
  const review = await runAtsReviewer({ profile, context: { evidenceBank: bank, preferences: { targetRoles: [], workPreferences: profile.workPreferences }, writingStyle: "plain" }, strategy, document, posting: expected.posting, execute: async () => JSON.stringify(expected.review) });
  assert.equal(review.issues[0]?.kind, "missing_but_supported");
  assert.deepEqual(review.issues[0]?.evidenceRefs, expected.review.issues[0]?.evidenceRefs);
  assert.deepEqual(AtsReviewSchema.parse(review), review);
});

test("deterministic ATS PDF checks catch contact, employer, date, glyph, and duplicate-bullet failures", () => {
  const { profile } = fixture();
  const bad = deterministicAtsChecks({ cvText: "- Same bullet\n- Same bullet\n(cid:12) �", coverLetterText: "", profile });
  assert.deepEqual(bad.issues, ["email_missing", "phone_missing", "employer_missing", "date_missing", "cid_glyph_error", "replacement_character", "duplicate_bullet"]);
  const good = deterministicAtsChecks({ cvText: "Ada Example Labs Jan 2024 - Present\nJava\n- Built services", coverLetterText: "ada@example.test +1 555 0100", profile });
  assert.deepEqual(good.issues, []);
});

test("ATS cannot attach evidence to a genuine gap", async () => {
  const { profile, bank, strategy, document } = fixture();
  await assert.rejects(() => runAtsReviewer({ profile, context: { evidenceBank: bank, preferences: { targetRoles: [], workPreferences: profile.workPreferences }, writingStyle: "plain" }, strategy, document, posting: "Go role", execute: async () => JSON.stringify({ issues: [{ requirement: "Go", kind: "genuine_gap", evidenceRefs: [bank.items[0]!.ref], note: "No Go." }], summary: "Gap." }) }), /genuine_gap/);
});

test("generation factual-audits a supported ATS revision before promotion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-ats-generation-"));
  const db = openDatabase(":memory:");
  const id = randomUUID();
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "ats-source", "manual", "https://example.test/ats", "Example", "Engineer", "Java backend role", 80, JSON.stringify({ reason: "fit", strengths: [], gaps: [] }), "Selected", "2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
  const { profile, bank, strategy, document } = fixture();
  const ref = bank.items.find(item => item.ref === "experience:exp:bullet:0")!.ref;
  const runner: CommandRunner = async (executable, args, _timeout, cwd) => {
    if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), "cv");
    if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "letter");
    if (executable === "pdfinfo") return { code: 0, stdout: `Pages: ${args[0] === "cv.pdf" ? 2 : 1}\n`, stderr: "" };
    if (executable === "pdftotext") return { code: 0, stdout: "ada@example.test +1 555 0100", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  let revisionCalls = 0;
  let auditCalls = 0;
  try {
    await assert.rejects(() => generateJob({
      db, dataDir: dir, jobId: id, settings: defaultSettings, profile: JSON.stringify(profile), execute: async () => { throw new Error("legacy path must not run"); }, runner, signal: new AbortController().signal,
      strategist: async () => strategy,
      writer: async () => document,
      auditor: async ({ document: current }) => {
        auditCalls += 1;
        return current.summary.text.includes("enterprise-wide")
          ? { issues: [{ kind: "scope_inflation", severity: "critical" as const, claim: current.summary.text, evidenceRefs: [ref], note: "Scope is broader than the evidence." }] }
          : { issues: [] };
      },
      critic: async () => ({ score: 8, issues: [], summary: "Ready." }),
      atsReviewer: async () => ({ issues: [{ requirement: "Java", kind: "missing_but_supported" as const, evidenceRefs: [bank.items.find(item => item.ref === "skill:java")!.ref], note: "Add Java." }], summary: "Supported omission." }),
      reviser: async input => { revisionCalls += 1; return { ...input.document, summary: { ...input.document.summary, text: "Architected enterprise-wide event-driven platforms." } }; },
      atsEnabled: true,
    }), /Critical factual issue: scope_inflation/);
    assert.equal(revisionCalls, 1);
    assert.equal(auditCalls, 2);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("generation permits one supported ATS revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-ats-generation-success-"));
  const db = openDatabase(":memory:");
  const id = randomUUID();
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "ats-source", "manual", "https://example.test/ats", "Example", "Engineer", "Java backend role", 80, JSON.stringify({ reason: "fit", strengths: [], gaps: [] }), "Selected", "2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
  const { profile, bank, strategy, document } = fixture();
  const runner: CommandRunner = async (executable, args, _timeout, cwd) => {
    if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), "cv");
    if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "letter");
    if (executable === "pdfinfo") return { code: 0, stdout: `Pages: ${args[0] === "cv.pdf" ? 2 : 1}\n`, stderr: "" };
    if (executable === "pdftotext") return { code: 0, stdout: "ada@example.test +1 555 0100", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  let revisionCalls = 0;
  try {
    await generateJob({
      db, dataDir: dir, jobId: id, settings: defaultSettings, profile: JSON.stringify(profile), execute: async () => { throw new Error("legacy path must not run"); }, runner, signal: new AbortController().signal,
      strategist: async () => strategy,
      writer: async () => document,
      auditor: async () => ({ issues: [] }),
      critic: async () => ({ score: 8, issues: [], summary: "Ready." }),
      atsReviewer: async () => ({ issues: [{ requirement: "Java", kind: "missing_but_supported" as const, evidenceRefs: [bank.items.find(item => item.ref === "skill:java")!.ref], note: "Add Java." }], summary: "Supported omission." }),
      reviser: async input => { revisionCalls += 1; return input.document; },
      atsEnabled: true,
    });
    assert.equal(revisionCalls, 1);
    const ats = JSON.parse(await readFile(join(dir, "applications", id, "current", "ats.json"), "utf8"));
    assert.equal(ats.issues[0].kind, "missing_but_supported");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
