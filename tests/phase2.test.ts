import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.js";
import { buildServer } from "../src/server/app.js";
import { compileAndVerify, containedPath, type CommandRunner } from "../src/server/documents.js";
import { defaultSettings } from "../src/server/config.js";
import { generateJob, buildGenerationPrompt, validateGenerationOutput } from "../src/server/generation.js";
import { loadTemplateMetadata, selectCvTemplate, TemplateMetadataSchema } from "../src/server/templates.js";
import { createFauxRestrictedGenerationSession } from "../src/server/pi.js";
import type { StructuredProfile } from "../src/shared.js";

function insertJob(db: any, stage = "Selected", suffix = "1") {
  const id = randomUUID();
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `s-${suffix}`, "freehire", `https://example.test/${suffix}`, "Example", "Engineer", "Posting", 80, JSON.stringify({ reason: "fit", strengths: [], gaps: ["Kubernetes"] }), stage, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  return id;
}

async function wait(app: any, id: string) {
  for (let i = 0; i < 100; i++) {
    const body = (await app.inject({ url: `/api/runs/${id}` })).json();
    if (body.status !== "running") return body;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("run did not finish");
}

const profile = "# Fixture profile\nEmail: person@example.test\nPhone: +62 812 3456 7890\nTypeScript";
const fakeRunner: CommandRunner = async (executable, args, _timeout, cwd) => {
  if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), "pdf");
  if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "pdf");
  if (executable === "pdfinfo") return { code: 0, stdout: `Pages: ${args[0] === "cv.pdf" ? 2 : 1}\n`, stderr: "" };
  if (executable === "pdftotext") return { code: 0, stdout: "person@example.test +62 812 3456 7890 content", stderr: "" };
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

test("document verification checks compilers, page counts, text, and literal contacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-doc-"));
  try {
    await writeFile(join(dir, "cv.tex"), "x");
    await writeFile(join(dir, "cover-letter.tex"), "x");
    const result = await compileAndVerify({ currentDir: dir, cvPages: 2, coverLetterPages: 1, email: "person@example.test", phone: "+62 812 3456 7890", runner: fakeRunner });
    assert.equal(result.success, true);
    await assert.rejects(() => compileAndVerify({ currentDir: dir, cvPages: 3, coverLetterPages: 1, email: "person@example.test", phone: "+62 812 3456 7890", runner: fakeRunner }), /CV must/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("structured profile generation renders a usable CV and cover letter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-structured-generation-"));
  const db = openDatabase(":memory:");
  const jobId = insertJob(db);
  const profileText = await readFile(join(process.cwd(), "data/profile.json"), "utf8");
  const structured = JSON.parse(profileText) as StructuredProfile;
  const experience = structured.experience.find(entry => entry.title || entry.company || entry.description);
  const skill = structured.skills.find(entry => entry.name);
  if (!experience || !skill) throw new Error("Canonical profile fixture needs experience and skills.");
  const profileFact = structured.identity.summary || experience.description || skill.name;
  const runner: CommandRunner = async (executable, args, _timeout, cwd) => {
    if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), "pdf");
    if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "pdf");
    if (executable === "pdfinfo") return { code: 0, stdout: `Pages: ${args[0] === "cv.pdf" ? 2 : 1}\n`, stderr: "" };
    if (executable === "pdftotext") return { code: 0, stdout: `${structured.identity.email} ${structured.identity.phone} content`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await generateJob({
      db,
      dataDir: dir,
      jobId,
      settings: defaultSettings,
      profile: profileText,
      execute: async () => ({
        cvTemplate: "backend_java_spring",
        profileFacts: [profileFact],
        roleEmphasis: [skill.name],
        cvEdits: [skill.name],
        coverLetterParagraphs: [`Engineer at Example needs ${skill.name}.`, experience.description, `I would bring ${skill.name} to this role.`],
        coverLetterBullets: [experience.description],
        gaps: [],
      }),
      runner,
      signal: new AbortController().signal,
      now: "2026-08-14T12:00:00.000Z",
    });
    const currentDir = join(dir, "applications", jobId, "current");
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

test("generate is Selected-only, sequential, keeps Drafting, archives, approves, and explicitly applies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-p2-"));
  const db = openDatabase(":memory:");
  const first = insertJob(db, "Selected", "1");
  const second = insertJob(db, "Selected", "2");
  const recommended = insertJob(db, "Recommended", "3");
  const order: string[] = [];
  const app = await buildServer({ dataDir: dir, db, commandRunner: fakeRunner, generationExecutor: async context => { order.push(String(context.job.id)); return { cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: ["Kubernetes"] }; } });
  try {
    await app.inject({ method: "PUT", url: "/api/profile", payload: { profile } });
    const rejected = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [recommended] } });
    assert.equal(rejected.statusCode, 409);
    assert.equal((db.prepare("SELECT stage FROM jobs WHERE id=?").get(recommended) as any).stage, "Recommended");
    const start = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [first, second] } });
    assert.equal(start.statusCode, 202);
    assert.equal((await wait(app, start.json().runId)).status, "succeeded");
    assert.deepEqual(order, [first, second]);
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

test("busy generation returns HTTP 409", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-busy-"));
  const db = openDatabase(":memory:");
  const first = insertJob(db, "Selected", "busy-1");
  const second = insertJob(db, "Selected", "busy-2");
  let release: () => void = () => {};
  const blocked = new Promise<void>(resolve => { release = () => resolve(); });
  const app = await buildServer({ dataDir: dir, db, commandRunner: fakeRunner, generationExecutor: async () => { await blocked; return { cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: ["Kubernetes"] }; } });
  try {
    await app.inject({ method: "PUT", url: "/api/profile", payload: { profile } });
    const start = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [first] } });
    assert.equal(start.statusCode, 202);
    const conflict = await app.inject({ method: "POST", url: "/api/generate", payload: { jobIds: [second] } });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), { error: "Another AI run is already active." });
    release();
    assert.equal((await wait(app, start.json().runId)).status, "succeeded");
  } finally { release(); await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("compile failure remains Drafting and cannot approve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-faildoc-"));
  const db = openDatabase(":memory:");
  const id = insertJob(db);
  const app = await buildServer({ dataDir: dir, db, generationExecutor: async () => ({ cvTemplate: "backend_java_spring", profileFacts: ["TypeScript"], gaps: [] }), commandRunner: async () => ({ code: 1, stdout: "", stderr: "secret compiler detail" }) });
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
