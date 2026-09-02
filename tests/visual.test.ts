import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rasterizePdfPages, runVisualReviewer } from "../src/server/visual.js";
import { createEmptyProfile } from "../src/shared.js";
import { buildEvidenceBank } from "../src/server/agents/evidence.js";
import { generateJob } from "../src/server/generation.js";
import { defaultSettings } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";

test("visual rasterizer returns page images and skips unavailable tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-visual-"));
  try {
    await writeFile(join(dir, "cv.pdf"), "pdf");
    await writeFile(join(dir, "cover-letter.pdf"), "pdf");
    const ready = await rasterizePdfPages({ currentDir: dir, runner: async (_executable, args) => {
      await writeFile(`${args.at(-1)}-1.png`, "png");
      return { code: 0, stdout: "", stderr: "" };
    } });
    assert.equal(ready.status, "ready");
    assert.equal(ready.pages.length, 2);
    const skipped = await rasterizePdfPages({ currentDir: dir, runner: async () => { throw new Error("pdftoppm missing"); } });
    assert.equal(skipped.status, "skipped");
    assert.deepEqual(skipped.pages, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("visual reviewer parses a bounded review from rendered pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-visual-agent-"));
  try {
    const page = join(dir, "page.png");
    await writeFile(page, "png");
    const review = await runVisualReviewer({
      pagePaths: [page],
      document: { summary: { text: "Engineer", evidenceRefs: [] }, experiences: [], skillIds: [], projects: [], coverLetter: { subject: "Engineer", paragraphs: [] } },
      execute: async prompt => {
        assert.match(prompt, /RENDERED DOCUMENT PAGES/);
        return JSON.stringify({ status: "passed", issues: [], summary: "Readable." });
      },
    });
    assert.deepEqual(review, { status: "passed", issues: [], summary: "Readable." });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("visual findings trigger at most one document revision before promotion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-visual-generation-"));
  const db = openDatabase(":memory:");
  const profile = createEmptyProfile();
  Object.assign(profile.identity, { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: "+1 555 0100" });
  profile.experience = [{ id: "exp", title: "Engineer", company: "Example", employmentType: "Full-time", location: "Remote", startMonth: "", startYear: "2024", endMonth: "", endYear: "", currentRole: true, description: "Built Java services." }];
  profile.skills = [{ id: "java", name: "Java" }];
  const bank = buildEvidenceBank(profile);
  const ref = bank.items.find(item => item.ref === "experience:exp:bullet:0")!.ref;
  const strategy = { positioning: "Engineer", targetRole: "Engineer", primarySellingPoints: [{ angle: "Java", evidenceRefs: [ref] }], requirements: [{ requirement: "Java", importance: "critical" as const, candidateFit: "strong" as const, evidenceRefs: [ref] }], narrativeGuidance: ["Lead with Java."], deEmphasize: [], genuineGaps: [], rankDisagreements: [] };
  const document = { summary: { text: "Engineer", evidenceRefs: [ref] }, experiences: [{ experienceId: "exp", bullets: [{ text: "Built Java services.", evidenceRefs: [ref], transformation: "rewrite" as const }] }], skillIds: ["java"], projects: [], coverLetter: { subject: "Engineer", paragraphs: [{ text: "I build Java services.", evidenceRefs: [ref] }] } };
  const jobId = "visual-job";
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(jobId, "visual-source", "manual", "https://example.test/visual", "Example", "Engineer", "Java role", 80, JSON.stringify({ reason: "fit", strengths: [], gaps: [] }), "Selected", "2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
  let revisions = 0;
  let audits = 0;
  let compilePass = 0;
  const visualReviews: string[][] = [];
  let reviserVisualIssues: string[] = [];
  const runner = async (executable: string, args: string[], _timeout?: number, cwd?: string) => {
    if (executable === "lualatex") { compilePass += 1; await writeFile(join(cwd!, "cv.pdf"), "cv"); }
    if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "letter");
    if (executable === "pdftoppm") await writeFile(`${args.at(-1)}-${compilePass}.png`, "png");
    if (executable === "pdfinfo") return { code: 0, stdout: `Pages: ${args[0] === "cv.pdf" ? 2 : 1}\n`, stderr: "" };
    if (executable === "pdftotext") return { code: 0, stdout: "Example 2024 ada@example.test +1 555 0100", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  try {
    await generateJob({ db, dataDir: dir, jobId, settings: defaultSettings, profile: JSON.stringify(profile), execute: async () => ({}), runner, signal: new AbortController().signal, strategist: async () => strategy, writer: async () => document, auditor: async () => { audits += 1; return { issues: [] }; }, critic: async () => ({ score: 8, issues: [], summary: "Ready." }), reviser: async input => { revisions += 1; reviserVisualIssues = input.visual?.issues ?? []; return input.document; }, visualQa: async input => { visualReviews.push(input.pagePaths); return visualReviews.length === 1 ? { status: "needs_review", issues: ["crowded footer"], summary: "Layout needs a pass." } : { status: "passed", issues: [], summary: "Final layout is readable." }; }, visualEnabled: true });
    assert.equal(revisions, 1);
    assert.deepEqual(reviserVisualIssues, ["crowded footer"]);
    assert.equal(audits, 2);
    assert.equal(visualReviews.length, 2);
    assert.notDeepEqual(visualReviews[0], visualReviews[1]);
    assert.ok(visualReviews[1]?.every(page => page.endsWith("-2.png")));
    const visual = JSON.parse(await readFile(join(dir, "applications", jobId, "current", "visual.json"), "utf8"));
    assert.equal(visual.revisionApplied, true);
    assert.equal(visual.status, "passed");
    assert.ok(visual.pages.every((page: string) => page.endsWith("-2.png")));
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
