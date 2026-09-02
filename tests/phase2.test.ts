import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, updateJobDirection } from "../src/server/db.js";
import { buildServer } from "../src/server/app.js";
import { compileAndVerify, containedPath, type CommandRunner } from "../src/server/documents.js";
import { defaultSettings } from "../src/server/config.js";
import { generateJob, buildGenerationPrompt, validateGenerationOutput } from "../src/server/generation.js";
import { loadTemplateMetadata, selectCvTemplate, TemplateMetadataSchema } from "../src/server/templates.js";
import { createFauxRestrictedGenerationSession } from "../src/server/pi.js";
import { defaultGenerationDirection, createEmptyProfile } from "../src/shared.js";
import type { ApplicationStrategy, CVDocument } from "../src/server/agents/types.js";
import { splitDescriptionIntoBullets } from "../src/server/agents/evidence.js";
import type { RunStrategistInput } from "../src/server/agents/strategist.js";
import type { RunWriterInput } from "../src/server/agents/writer.js";

function insertJob(db: any, stage = "Selected", suffix = "1") {
  const id = randomUUID();
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `s-${suffix}`, "freehire", `https://example.test/${suffix}`, "Example", "Engineer", "Posting", 80, JSON.stringify({ reason: "fit", strengths: [], gaps: ["Kubernetes"] }), stage, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  return id;
}

async function wait(app: any, id: string) {
  for (let i = 0; i < 100; i++) {
    const body = (await app.inject({ url: `/api/runs/${id}` })).json();
    if (body.status !== "running" && body.status !== "queued") return body;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("run did not finish");
}

const profile = "# Fixture profile\nEmail: person@example.test\nPhone: +62 812 3456 7890\nTypeScript";

async function stubStrategist(input: RunStrategistInput): Promise<ApplicationStrategy> {
  const ref = input.context.evidenceBank.items[0]?.ref;
  if (!ref) throw new Error("stub strategist needs at least one evidence item");
  return {
    positioning: "Backend engineer.",
    targetRole: "Engineer",
    primarySellingPoints: [{ angle: "Matching experience", evidenceRefs: [ref] }],
    requirements: [{ requirement: "Core skills", importance: "critical", candidateFit: "strong", evidenceRefs: [ref] }],
    narrativeGuidance: ["Lead with matching work."],
    deEmphasize: [],
    genuineGaps: ["Kubernetes"],
    rankDisagreements: [],
  };
}

async function stubAuditor() {
  return { issues: [] };
}

async function stubCritic() {
  return { score: 8, issues: [], summary: "On strategy." };
}

async function stubWriter(input: RunWriterInput): Promise<CVDocument> {
  const fallback = input.context.evidenceBank.items[0]?.ref;
  if (!fallback) throw new Error("stub writer needs at least one evidence item");
  const refsFor = (entityId: string, kind: string) =>
    input.context.evidenceBank.items.filter(item => item.source.entityId === entityId && item.kind === kind).map(item => item.ref);
  const summaryRefs = refsFor("identity", "identity");
  return {
    summary: { text: input.strategy.positioning, evidenceRefs: summaryRefs.length ? summaryRefs : [fallback] },
    experiences: input.profile.experience
      .filter(entry => entry.title.trim() || entry.company.trim() || entry.description.trim())
      .map(entry => {
        const evidence = refsFor(entry.id, "experience");
        const lines = splitDescriptionIntoBullets(entry.description).map(item => item.trim()).filter(Boolean);
        const bullets = lines.length ? lines : ["Delivered production work."];
        return {
          experienceId: entry.id,
          bullets: bullets.map((text, index) => ({
            text,
            evidenceRefs: evidence[index] ? [evidence[index]!] : evidence[0] ? [evidence[0]] : [fallback],
            transformation: "rewrite" as const,
          })),
        };
      }),
    skillIds: input.profile.skills.filter(entry => entry.name.trim()).map(entry => entry.id),
    projects: input.profile.projects
      .filter(entry => entry.name.trim() || entry.role.trim() || entry.description.trim())
      .map(entry => ({ projectId: entry.id })),
    coverLetter: {
      subject: `Application for ${input.strategy.targetRole}`,
      paragraphs: [{ text: input.strategy.narrativeGuidance[0] ?? input.strategy.positioning, evidenceRefs: [fallback] }],
    },
  };
}
const fakeRunner: CommandRunner = async (executable, args, _timeout, cwd) => {
  if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), "pdf");
  if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "pdf");
  if (executable === "pdfinfo") return { code: 0, stdout: `Pages: ${args[0] === "cv.pdf" ? 2 : 1}\n`, stderr: "" };
  if (executable === "pdftotext") return { code: 0, stdout: "Example 2024 person@example.test +62 812 3456 7890 content", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

test("template metadata, structured truth boundary, and path containment", async () => {
  const loaded = await loadTemplateMetadata();
  assert.equal(selectCvTemplate(loaded.metadata, ["java"]), "backend_java_spring");
  assert.throws(() => TemplateMetadataSchema.parse({ cv: { x: { file: "../bad.tex", tags: [] } }, coverLetter: "cover-letter.tex" }));
  assert.throws(() => validateGenerationOutput({ cvTemplate: "backend_java_spring", profileFacts: ["invented"], gaps: [] }, profile, ["backend_java_spring"], ["Kubernetes"]), /unsupported profile fact/);
  assert.throws(() => validateGenerationOutput("not json", profile, ["backend_java_spring"], []));
  assert.throws(() => containedPath("C:/safe", "..", "escape"));
});

test("generation Pi session exposes no tools", async () => {
  const session = await createFauxRestrictedGenerationSession();
  try { assert.deepEqual(session.getActiveToolNames(), []); } finally { session.dispose(); }
});

test("document verification requires exact target pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-doc-"));
  try {
    await writeFile(join(dir, "cv.tex"), "x");
    await writeFile(join(dir, "cover-letter.tex"), "x");
    const result = await compileAndVerify({ currentDir: dir, cvPages: 2, coverLetterPages: 1, email: "person@example.test", phone: "+62 812 3456 7890", runner: fakeRunner });
    assert.equal(result.success, true);
    assert.equal(result.cvPages, 2);
    assert.equal(result.coverLetterPages, 1);
    await assert.rejects(() => compileAndVerify({ currentDir: dir, cvPages: 3, coverLetterPages: 2, email: "person@example.test", phone: "+62 812 3456 7890", runner: fakeRunner }), /CV must be exactly 3 pages/);
    await assert.rejects(() => compileAndVerify({ currentDir: dir, cvPages: 1, coverLetterPages: 1, email: "person@example.test", phone: "+62 812 3456 7890", runner: fakeRunner }), /CV must be exactly 1 page/);
    await assert.rejects(() => compileAndVerify({ currentDir: dir, cvPages: 2, coverLetterPages: 0, email: "person@example.test", phone: "+62 812 3456 7890", runner: fakeRunner }), /Cover letter must be exactly 0 pages/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("structured profile generation renders a usable CV and cover letter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-structured-generation-"));
  const db = openDatabase(":memory:");
  const jobId = insertJob(db);
  const structured = createEmptyProfile();
  Object.assign(structured.identity, {
    firstName: "Ada",
    lastName: "Lovelace",
    headline: "Backend Engineer",
    email: "ada@example.test",
    phone: "+1 555 0100",
    city: "London",
    country: "United Kingdom",
    summary: "Backend engineer focused on Java platforms.",
  });
  structured.experience = [{
    id: "exp-aetherwave",
    title: "Backend Engineer",
    company: "Aetherwave Robotics Ltd",
    employmentType: "Full-time",
    location: "Remote",
    startMonth: "",
    startYear: "2024",
    endMonth: "",
    endYear: "",
    currentRole: true,
    description: "Built Java services.",
  }];
  structured.skills = [{ id: "skill-java", name: "Java" }];
  structured.projects = [{ id: "proj-api", name: "Backend API Platform", role: "Backend Engineer", description: "Built Java Spring Boot services.", startMonth: "", startYear: "", endMonth: "", endYear: "", url: "" }];
  structured.education = [{ id: "edu-1", institution: "Canonical University", degree: "Bachelor of Science", fieldOfStudy: "Computer Science", startMonth: "", startYear: "2012", endMonth: "", endYear: "2016", gpa: "" }];
  structured.certifications = [{ id: "cert-1", name: "AWS Certified", issuer: "Amazon", issueDate: "", expiryDate: "", url: "", description: "" }];
  structured.languages = [{ id: "lang-en", name: "English", proficiency: "Native" }];
  const profileText = JSON.stringify(structured);
  const experience = structured.experience[0]!;
  const runner: CommandRunner = async (executable, args, _timeout, cwd) => {
    if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), "pdf");
    if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "pdf");
    if (executable === "pdfinfo") return { code: 0, stdout: `Pages: ${args[0] === "cv.pdf" ? 2 : 1}\n`, stderr: "" };
    if (executable === "pdftotext") return { code: 0, stdout: `${experience.company} ${experience.startYear} ${structured.identity.email} ${structured.identity.phone} content`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  let revisionCalls = 0;
  let researchCalls = 0;
  try {
    await generateJob({
      db,
      dataDir: dir,
      jobId,
      settings: defaultSettings,
      profile: profileText,
      execute: async () => {
        throw new Error("structured generate must not call execute");
      },
      runner,
      signal: new AbortController().signal,
      now: "2026-08-14T12:00:00.000Z",
      runId: "phase2-structured",
      strategist: stubStrategist,
      writer: stubWriter,
      auditor: async () => ({ issues: [] }),
      critic: async () => ({ score: 5, issues: [{ severity: "medium" as const, dimension: "specificity" as const, note: "Needs a sharper lead." }], summary: "Needs revision." }),
      reviser: async input => { revisionCalls += 1; return input.document; },
      researcher: async () => { researchCalls += 1; throw new Error("research should stay off"); },
      researchEnabled: false,
    });
    assert.equal(revisionCalls, 2);
    assert.equal(researchCalls, 0);
    const currentDir = join(dir, "applications", jobId, "current");
    const strategyText = await readFile(join(dir, "applications", jobId, "revisions", "phase2-structured", "strategy.json"), "utf8");
    assert.match(strategyText, /\n$/);
    assert.equal(JSON.parse(strategyText).targetRole, "Engineer");
    assert.equal(JSON.parse(await readFile(join(currentDir, "strategy.json"), "utf8")).targetRole, "Engineer");
    assert.equal(JSON.parse(await readFile(join(currentDir, "document.json"), "utf8")).summary.text, "Backend engineer.");
    const cv = await readFile(join(currentDir, "cv.tex"), "utf8");
    const letter = await readFile(join(currentDir, "cover-letter.tex"), "utf8");
    const documents = `${cv}\n${letter}`;
    const literal = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    assert.match(cv, /Professional Summary/);
    assert.match(cv, /Core Skills/);
    assert.match(cv, /Professional Experience/);
    assert.match(cv, /Selected Projects/);
    assert.match(cv, /Education/);
    assert.match(cv, /Certifications/);
    assert.match(cv, /Languages/);
    assert.match(cv, literal(`\\name{${structured.identity.firstName}}{${structured.identity.lastName}}`));
    assert.match(cv, literal(experience.title.replace(/&/g, "\\&")));
    assert.match(cv, literal(experience.company));
    assert.match(cv, /\\cventry\{2024 - Present\}\{Backend Engineer\}\{Aetherwave Robotics Ltd\}/);
    assert.match(letter, /Subject:/);
    assert.match(letter, /Dear Example hiring team/);
    assert.match(letter, /Kind regards/);
    assert.match(letter, literal(`${structured.identity.firstName} ${structured.identity.lastName}`));
    for (const marker of ["fixture", "requires human review", "Selected CV edits", "Acknowledged gaps", "This editable draft"]) assert.doesNotMatch(documents, new RegExp(marker, "i"));
    assert.doesNotMatch(documents, /[\u2011\u2013\u2014]|--+/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("structured generation uses the per-job CV page override and DISK cover-letter default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-override-generation-"));
  const db = openDatabase(":memory:");
  const jobId = insertJob(db, "Selected", "override-generation");
  const structured = createEmptyProfile();
  Object.assign(structured.identity, {
    firstName: "Ada",
    lastName: "Lovelace",
    headline: "Backend Engineer",
    email: "ada@example.test",
    phone: "+1 555 0100",
    summary: "Backend engineer focused on reliable Java platforms.",
  });
  structured.experience = [{ id: "exp-override", title: "Backend Engineer", company: "Example", employmentType: "Full-time", location: "Remote", startMonth: "", startYear: "2024", endMonth: "", endYear: "", currentRole: true, description: "Built Java services." }];
  structured.skills = [{ id: "skill-java", name: "Java" }];
  updateJobDirection(db, jobId, { cvPagesOverride: 3 });
  const observedPages: number[] = [];
  const runner: CommandRunner = async (executable, args, _timeout, cwd) => {
    if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), "pdf");
    if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "pdf");
    if (executable === "pdfinfo") {
      const pages = args[0] === "cv.pdf" ? 3 : 1;
      observedPages.push(pages);
      return { code: 0, stdout: `Pages: ${pages}\n`, stderr: "" };
    }
    if (executable === "pdftotext") return { code: 0, stdout: `Example 2024 ${structured.identity.email} ${structured.identity.phone} content`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    const result = await generateJob({
      db,
      dataDir: dir,
      settings: { ...defaultSettings, cvPages: 2, coverLetterPages: 1 },
      profile: JSON.stringify(structured),
      jobId,
      execute: async () => { throw new Error("structured generation must not call the legacy executor"); },
      runner,
      signal: new AbortController().signal,
      strategist: stubStrategist,
      writer: async input => {
        assert.equal(input.settings?.cvPages, 2);
        assert.equal(input.cvPageEstimate, 1);
        return stubWriter(input);
      },
      auditor: stubAuditor,
      critic: stubCritic,
    });
    assert.equal(result.verification.success, true);
    assert.deepEqual(observedPages, [3, 1]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("generate is Selected-only, sequential, keeps Drafting, archives, approves, and explicitly applies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-p2-"));
  const db = openDatabase(":memory:");
  const first = insertJob(db, "Selected", "1");
  const second = insertJob(db, "Selected", "2");
  const recommended = insertJob(db, "Recommended", "3");
  const app = await buildServer({ dataDir: dir, db, commandRunner: fakeRunner, generationExecutor: async () => ({ cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: ["Kubernetes"] }), strategist: stubStrategist, writer: stubWriter, auditor: stubAuditor, critic: stubCritic });
  try {
    await app.inject({ method: "PUT", url: "/api/profile", payload: { profile } });
    const rejected = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [recommended] } });
    assert.equal(rejected.statusCode, 409);
    assert.equal((db.prepare("SELECT stage FROM jobs WHERE id=?").get(recommended) as any).stage, "Recommended");
    const start = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [first, second] } });
    assert.equal(start.statusCode, 202);
    const runId = start.json().runId;
    const done = await wait(app, runId);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.summary.results.map((result: { jobId: string }) => result.jobId), [first, second]);
    const trajectory = (await app.inject({ url: `/api/runs/${runId}/trajectory` })).json();
    const taskIds = new Set(trajectory.events.filter((event: { type: string }) => event.type.startsWith("task_")).map((event: { payload?: { taskId?: string } }) => event.payload?.taskId));
    for (const taskId of [`generate:${first}:strategy`, `generate:${first}:writer`, `generate:${first}:claims`, `generate:${first}:audit:0`, `generate:${first}:critic:0`, `generate:${first}:documents`, `generate:${first}:finalize`]) assert.ok(taskIds.has(taskId), taskId);
    for (const id of [first, second]) assert.equal((db.prepare("SELECT stage FROM jobs WHERE id=?").get(id) as any).stage, "Drafting");
    const detail = (await app.inject({ url: `/api/jobs/${first}` })).json();
    assert.equal(detail.verification.success, true);
    const cvPdf = await app.inject({ url: `/api/files/${first}/cv.pdf` });
    assert.equal(cvPdf.statusCode, 200);
    assert.equal(cvPdf.headers["content-disposition"], 'inline; filename="cv_example_engineer.pdf"');
    const coverLetterPdf = await app.inject({ url: `/api/files/${first}/cover-letter.pdf` });
    assert.equal(coverLetterPdf.statusCode, 200);
    assert.equal(coverLetterPdf.headers["content-disposition"], 'inline; filename="cover_letter_example_engineer.pdf"');
    const cvSource = await app.inject({ url: `/api/files/${first}/cv.tex` });
    assert.equal(cvSource.headers["content-disposition"], 'inline; filename="cv_example_engineer.tex"');
    assert.equal((await app.inject({ url: `/api/files/${first}/../verification.json` })).statusCode, 404);
    const regen = await app.inject({ method: "POST", url: `/api/jobs/${first}/regenerate` });
    await wait(app, regen.json().runId);
    assert.ok((await readdirSafe(join(dir, "applications", first, "history"))).length > 0);
    assert.equal((await app.inject({ method: "POST", url: `/api/jobs/${first}/approve` })).json().stage, "Ready");
    const badApply = await app.inject({ method: "POST", url: `/api/jobs/${second}/applied`, payload: { submittedAt: "2026-08-12", channel: "Portal", notes: "" } });
    assert.equal(badApply.statusCode, 409);
    const applied = await app.inject({ method: "POST", url: `/api/jobs/${first}/applied`, payload: { submittedAt: "2026-08-12", channel: "Portal", notes: "Manual submission" } });
    assert.equal(applied.json().stage, "Applied");
  } finally { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

async function readdirSafe(path: string) { return await import("node:fs/promises").then(fs => fs.readdir(path)); }

test("generation prompt enumerates only available local CV templates", () => {
  const prompt = buildGenerationPrompt({ profile, job: { role: "Engineer" }, rank: { gaps: [] }, templates: { cv: { backend_java_spring: { file: "cv/backend_java_spring.tex", tags: ["backend", "java"] } }, coverLetter: "cover-letter.tex" } }, "");
  assert.match(prompt, /Allowed local CV template IDs: \["backend_java_spring"\]/);
  assert.match(prompt, /cvTemplate to exactly one ID from this list, verbatim/);
  assert.doesNotMatch(prompt, /fixture/);
});

test("busy generation queues the next job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-busy-"));
  const db = openDatabase(":memory:");
  const first = insertJob(db, "Selected", "busy-1");
  const second = insertJob(db, "Selected", "busy-2");
  let release: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = () => resolve(); });
  const app = await buildServer({ dataDir: dir, db, commandRunner: fakeRunner, generationExecutor: async () => ({ cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: ["Kubernetes"] }), strategist: stubStrategist, writer: async input => { await blocked; return stubWriter(input); }, auditor: stubAuditor, critic: stubCritic });
  try {
    await app.inject({ method: "PUT", url: "/api/profile", payload: { profile } });
    const start = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [first] } });
    assert.equal(start.statusCode, 202);
    const queued = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [second] } });
    assert.equal(queued.statusCode, 202);
    release();
    assert.equal((await wait(app, start.json().runId)).status, "succeeded");
    assert.equal((await wait(app, queued.json().runId)).status, "succeeded");
  } finally { release(); await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("compile failure remains Drafting and cannot approve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-faildoc-"));
  const db = openDatabase(":memory:");
  const id = insertJob(db);
  const app = await buildServer({ dataDir: dir, db, generationExecutor: async () => ({ cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: [] }), commandRunner: async () => ({ code: 1, stdout: "", stderr: "secret compiler detail" }), strategist: stubStrategist, writer: stubWriter, auditor: stubAuditor, critic: stubCritic });
  try {
    await app.inject({ method: "PUT", url: "/api/profile", payload: { profile } });
    const run = (await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [id] } })).json();
    const done = await wait(app, run.runId);
    assert.equal(done.error, "Document generation failed.");
    assert.equal((db.prepare("SELECT stage FROM jobs WHERE id=?").get(id) as any).stage, "Drafting");
    const approval = await app.inject({ method: "POST", url: `/api/jobs/${id}/approve` });
    assert.equal(approval.statusCode, 409);
    assert.deepEqual(Object.keys(approval.json()), ["error"]);
    assert.doesNotMatch(JSON.stringify(done), /secret compiler detail/);
  } finally { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("generation prompt for short includes USER DIRECTION", () => {
  const prompt = buildGenerationPrompt({
    profile,
    job: { role: "Engineer" },
    rank: { gaps: [] },
    templates: { cv: { backend_java_spring: { file: "cv/backend_java_spring.tex", tags: ["backend", "java"] } }, coverLetter: "cover-letter.tex" },
    direction: { ...defaultGenerationDirection, cvLength: "short" },
  }, "");
  assert.match(prompt, /USER DIRECTION/);
  assert.match(prompt, /short/);
});

test("Ready regenerate returns 202 then Drafting with approved_at null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-ready-regen-"));
  const db = openDatabase(":memory:");
  const id = insertJob(db, "Selected", "ready-regen");
  const app = await buildServer({ dataDir: dir, db, commandRunner: fakeRunner, generationExecutor: async () => ({ cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: ["Kubernetes"] }), strategist: stubStrategist, writer: stubWriter, auditor: stubAuditor, critic: stubCritic });
  try {
    await app.inject({ method: "PUT", url: "/api/profile", payload: { profile } });
    const start = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [id] } });
    assert.equal(start.statusCode, 202);
    assert.equal((await wait(app, start.json().runId)).status, "succeeded");
    const approved = await app.inject({ method: "POST", url: `/api/jobs/${id}/approve` });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().stage, "Ready");
    assert.ok(approved.json().approved_at);
    const regen = await app.inject({ method: "POST", url: `/api/jobs/${id}/regenerate` });
    assert.equal(regen.statusCode, 202);
    assert.equal((await wait(app, regen.json().runId)).status, "succeeded");
    const after = (await app.inject({ url: `/api/jobs/${id}` })).json();
    assert.equal(after.stage, "Drafting");
    assert.equal(after.approved_at, null);
    assert.equal(after.generation_direction.revisionCount, 1);
  } finally { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("manual revise remains available after three successful revises", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-rev-unlimited-"));
  const db = openDatabase(":memory:");
  const id = insertJob(db, "Selected", "unlimited");
  const app = await buildServer({ dataDir: dir, db, commandRunner: fakeRunner, generationExecutor: async () => ({ cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: ["Kubernetes"] }), strategist: stubStrategist, writer: stubWriter, auditor: stubAuditor, critic: stubCritic });
  try {
    await app.inject({ method: "PUT", url: "/api/profile", payload: { profile } });
    const start = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [id] } });
    assert.equal(start.statusCode, 202);
    assert.equal((await wait(app, start.json().runId)).status, "succeeded");
    assert.equal((await app.inject({ url: `/api/jobs/${id}` })).json().generation_direction.revisionCount, 0);
    for (let round = 1; round <= 4; round += 1) {
      const regen = await app.inject({ method: "POST", url: `/api/jobs/${id}/regenerate` });
      assert.equal(regen.statusCode, 202);
      assert.equal((await wait(app, regen.json().runId)).status, "succeeded");
      assert.equal((await app.inject({ url: `/api/jobs/${id}` })).json().generation_direction.revisionCount, round);
    }
  } finally { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("ungrounded revisionNotes tokens are absent from compiled TeX", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-rev-leak-"));
  const db = openDatabase(":memory:");
  const id = insertJob(db, "Selected", "rev-leak");
  const leakProfile = `${profile}\nExampleCorp`;
    const refusal = "Exclude the unsupported claim about increasing quarterly ARR by 847% using the QZ-9912 converter. TypeScript.";
  try {
    await generateJob({
      db,
      dataDir: dir,
      jobId: id,
      settings: defaultSettings,
      profile: leakProfile,
      execute: async () => ({ cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: ["Kubernetes"] }),
      runner: fakeRunner,
      signal: new AbortController().signal,
      runId: "phase2-rev-leak-1",
      strategist: stubStrategist,
    });
    updateJobDirection(db, id, { revisionNotes: `${refusal} Lead with ExampleCorp.` });
    await generateJob({
      db,
      dataDir: dir,
      jobId: id,
      settings: defaultSettings,
      profile: leakProfile,
      execute: async () => ({
        cvTemplate: "backend_java_spring",
        profileFacts: ["TypeScript"],
        cvEdits: [refusal],
        coverLetterParagraphs: [
          "I have worked with TypeScript at ExampleCorp.",
          refusal,
        ],
        gaps: ["Kubernetes"],
      }),
      runner: fakeRunner,
      allowDrafting: true,
      signal: new AbortController().signal,
      runId: "phase2-rev-leak-2",
      strategist: stubStrategist,
    });
    const currentDir = join(dir, "applications", id, "current");
    const cv = await readFile(join(currentDir, "cv.tex"), "utf8");
    const letter = await readFile(join(currentDir, "cover-letter.tex"), "utf8");
    for (const document of [cv, letter]) {
      assert.doesNotMatch(document, /847\\?%/);
      assert.doesNotMatch(document, /QZ-9912/);
    }
    assert.match(letter, /ExampleCorp/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
