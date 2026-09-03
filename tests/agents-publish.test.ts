import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyProfile } from "../src/shared.js";
import { openDatabase } from "../src/server/db.js";
import { defaultSettings } from "../src/server/config.js";
import { generateJob } from "../src/server/generation.js";
import type { CommandRunner } from "../src/server/documents.js";
import type { RunStrategistInput } from "../src/server/agents/strategist.js";
import type { RunWriterInput } from "../src/server/agents/writer.js";
import type { ApplicationStrategy, CVDocument } from "../src/server/agents/types.js";

function insertJob(db: any) {
  const id = randomUUID();
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "publish-source", "manual", "https://example.test/publish", "Example", "Engineer", "Java backend services", 80, JSON.stringify({ reason: "fit", strengths: [], gaps: [] }), "Selected", "2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
  return id;
}

function profile() {
  const value = createEmptyProfile();
  Object.assign(value.identity, { firstName: "Ada", lastName: "Lovelace", headline: "Backend Engineer", email: "ada@example.test", phone: "+1 555 0100" });
  value.experience = [{ id: "exp", title: "Backend Engineer", company: "Example", employmentType: "Full-time", location: "Remote", startMonth: "", startYear: "2024", endMonth: "", endYear: "", currentRole: true, description: "Built Java services." }];
  value.skills = [{ id: "skill-java", name: "Java" }];
  return value;
}

async function strategist(input: RunStrategistInput): Promise<ApplicationStrategy> {
  const ref = input.context.evidenceBank.items[0]!.ref;
  return { positioning: "Java backend engineer.", targetRole: "Engineer", primarySellingPoints: [{ angle: "Java", evidenceRefs: [ref] }], requirements: [{ requirement: "Java", importance: "critical", candidateFit: "strong", evidenceRefs: [ref] }], narrativeGuidance: ["Lead with Java."], deEmphasize: [], genuineGaps: [], rankDisagreements: [] };
}

async function writer(input: RunWriterInput): Promise<CVDocument> {
  const ref = input.context.evidenceBank.items[0]!.ref;
  return { summary: { text: "Java backend engineer.", evidenceRefs: [ref] }, experiences: [{ experienceId: "exp", bullets: [{ text: "Built Java services.", evidenceRefs: [ref], transformation: "rewrite" }] }], skillIds: ["skill-java"], projects: [], coverLetter: { subject: "Engineer", paragraphs: [{ text: "I build Java services.", evidenceRefs: [ref] }] } };
}

function runner(bytes: string, signals: AbortSignal[], fail = false): CommandRunner {
  return async (executable, args, _timeout, cwd, signal) => {
    if (signal) signals.push(signal);
    if (fail && executable === "lualatex") return { code: 1, stdout: "", stderr: "compiler detail" };
    if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), bytes);
    if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), bytes);
    if (executable === "pdfinfo") return { code: 0, stdout: `Pages: ${args[0] === "cv.pdf" ? 2 : 1}\n`, stderr: "" };
    if (executable === "pdftotext") return { code: 0, stdout: "Example 2024 ada@example.test +1 555 0100", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

function options(input: { db: any; dataDir: string; jobId: string; runId: string; profile: string; runner: CommandRunner; allowDrafting?: boolean }) {
  return { ...input, settings: defaultSettings, execute: async () => { throw new Error("legacy executor must not run"); }, signal: new AbortController().signal, now: `2026-08-31T12:00:0${input.runId.endsWith("one") ? "1" : "2"}.000Z`, strategist, writer, auditor: async () => ({ issues: [] }), critic: async () => ({ score: 8, issues: [], summary: "Ready." }) };
}

test("failed revision compile leaves current bytes and verification unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-publish-"));
  const db = openDatabase(":memory:");
  const jobId = insertJob(db);
  const candidate = profile();
  const signals: AbortSignal[] = [];
  try {
    await generateJob(options({ db, dataDir: dir, jobId, runId: "publish-one", profile: JSON.stringify(candidate), runner: runner("first", signals) }));
    const current = join(dir, "applications", jobId, "current");
    assert.equal(await readFile(join(current, "cv.pdf"), "utf8"), "first");
    for (const name of ["cv.tex", "cover-letter.tex", "strategy.json", "document.json", "audit.json", "review.json", "verification.json"]) await readFile(join(current, name), "utf8");
    assert.deepEqual(await readdir(join(current, "drafts")), ["1.json"]);
    assert.ok(signals.length > 0 && signals.every(signal => signal instanceof AbortSignal));
    const before = (db.prepare("SELECT verification_json FROM applications WHERE job_id=?").get(jobId) as { verification_json: string }).verification_json;

    await assert.rejects(() => generateJob(options({ db, dataDir: dir, jobId, runId: "publish-two", profile: JSON.stringify(candidate), runner: runner("second", signals, true), allowDrafting: true })), /lualatex failed/);
    assert.equal(await readFile(join(current, "cv.pdf"), "utf8"), "first");
    assert.equal((db.prepare("SELECT verification_json FROM applications WHERE job_id=?").get(jobId) as { verification_json: string }).verification_json, before);
    await readFile(join(dir, "applications", jobId, "revisions", "publish-two", "cv.tex"), "utf8");
    await assert.rejects(() => readdir(join(dir, "applications", jobId, "history")));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("successful revision replaces current and preserves history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-publish-success-"));
  const db = openDatabase(":memory:");
  const jobId = insertJob(db);
  const candidate = profile();
  const signals: AbortSignal[] = [];
  try {
    await generateJob(options({ db, dataDir: dir, jobId, runId: "publish-one", profile: JSON.stringify(candidate), runner: runner("first", signals) }));
    await generateJob(options({ db, dataDir: dir, jobId, runId: "publish-two", profile: JSON.stringify(candidate), runner: runner("second", signals), allowDrafting: true }));
    const applicationDir = join(dir, "applications", jobId);
    assert.equal(await readFile(join(applicationDir, "current", "cv.pdf"), "utf8"), "second");
    const history = await readdir(join(applicationDir, "history"));
    assert.equal(history.length, 1);
    assert.equal(await readFile(join(applicationDir, "history", history[0]!, "cv.pdf"), "utf8"), "first");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("successful revisions retain only the three most recent history entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-publish-history-limit-"));
  const db = openDatabase(":memory:");
  const jobId = insertJob(db);
  const candidate = profile();
  const signals: AbortSignal[] = [];
  try {
    await generateJob(options({ db, dataDir: dir, jobId, runId: "publish-one", profile: JSON.stringify(candidate), runner: runner("first", signals) }));
    for (const [runId, bytes] of [["publish-two", "second"], ["publish-three", "third"], ["publish-four", "fourth"], ["publish-five", "fifth"]] as const) {
      await generateJob(options({ db, dataDir: dir, jobId, runId, profile: JSON.stringify(candidate), runner: runner(bytes, signals), allowDrafting: true }));
    }
    const applicationDir = join(dir, "applications", jobId);
    const history = await readdir(join(applicationDir, "history"));
    assert.equal(history.length, 3);
    assert.deepEqual((await Promise.all(history.map((entry) => readFile(join(applicationDir, "history", entry, "cv.pdf"), "utf8")))).sort(), ["fourth", "second", "third"]);
    assert.equal(await readFile(join(applicationDir, "current", "cv.pdf"), "utf8"), "fifth");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
