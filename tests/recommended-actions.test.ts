import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyProfile } from "../src/shared.js";
import { loadGuidance, guidanceFiles } from "../src/server/guidance.js";
import { validateGenerationOutput } from "../src/server/generation.js";
import { createScrapeTools, validateScrapeResult } from "../src/server/scrape.js";
import { openDatabase, persistScrape } from "../src/server/db.js";
import { buildServer } from "../src/server/app.js";
import type { ScrapeResult } from "../src/server/scrape.js";

const profile = JSON.stringify(createEmptyProfile()) + " TypeScript";
const generation = {
  cvTemplate: "backend_java_spring",
  roleEmphasis: ["TypeScript"],
  cvEdits: ["TypeScript"],
  profileFacts: ["TypeScript"],
  coverLetterSubject: "Application for Backend Engineer at Example",
  coverLetterParagraphs: ["I have worked with TypeScript."],
  coverLetterBullets: ["TypeScript"],
  gaps: ["Kubernetes"],
};

function scrapeJob(sourceId: string, url: string) {
  return { sourceId, source: "freehire", url, company: "Example", role: "Backend Engineer", location: "Remote", posting: "TypeScript Kubernetes", score: 81, reason: "fit", strengths: ["TypeScript"], gaps: ["Kubernetes"] };
}

const result = (jobs: ScrapeResult["jobs"]): ScrapeResult => ({ jobs });

test("guidance loader reads only the six mapped files and rejects arbitrary paths", async () => {
  assert.equal(Object.keys(guidanceFiles).length, 6);
  const text = await loadGuidance(["searchQueries", "evaluation"]);
  assert.match(text, /search|query/i);
  assert.match(text, /evaluation|score|fit/i);
  assert.doesNotMatch(text, /allowed-tools|Codex|<\/?system>/i);
  await assert.rejects(() => loadGuidance(["../SKILL.md"] as never), /allowlist/);
  const emptyRoot = await mkdtemp(join(tmpdir(), "pjs-guidance-"));
  try { await assert.rejects(() => loadGuidance(["searchQueries"], emptyRoot), /missing/i); }
  finally { await rm(emptyRoot, { recursive: true, force: true }); }
});

test("structured generation validates all tailored fields against supplied facts", () => {
  const valid = validateGenerationOutput(generation, profile, ["backend_java_spring"], ["Kubernetes"], "Backend Engineer at Example");
  assert.deepEqual(valid.roleEmphasis, ["TypeScript"]);
  assert.deepEqual(validateGenerationOutput({ ...generation, cvEdits: ["Invented production metric"] }, profile, ["backend_java_spring"], ["Kubernetes"], "Backend Engineer at Example").cvEdits, []);
  assert.throws(() => validateGenerationOutput({ ...generation, coverLetterParagraphs: ["I led an unverified global launch."] }, profile, ["backend_java_spring"], ["Kubernetes"], "Backend Engineer at Example"), /unsupported|grounded/i);
});

test("scrape validation enforces limits and normalized uniqueness before persistence", () => {
  const first = scrapeJob("one", "https://example.test/jobs/1?utm_source=x");
  const second = scrapeJob("two", "https://example.test/jobs/1?ref=copy");
  const provenance = new Map([[first.sourceId, first.url], [second.sourceId, second.url]]);
  assert.throws(() => validateScrapeResult(result([first, second]), provenance, 2), /duplicate|normalized/i);
  assert.throws(() => validateScrapeResult(result([first, scrapeJob("three", "https://example.test/jobs/3")]), new Map([["one", first.url], ["three", "https://example.test/jobs/3"]]), 1), /maximum|limit/i);
  const db = openDatabase(":memory:");
  try {
    assert.throws(() => persistScrape(db, result([first, scrapeJob("three", "https://example.test/jobs/3")]), 60, undefined, 1), /maximum|limit/i);
    assert.equal((db.prepare("SELECT count(*) AS count FROM jobs").get() as { count: number }).count, 0);
  } finally { db.close(); }
});

test("scrape wrapper keeps a fixed command shape and rejects adversarial inputs", async () => {
  const calls: string[][] = [];
  const tools = createScrapeTools({ runCli: async (args) => { calls.push(args); return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) }; } });
  await tools.searchJobs.execute("search", { query: "backend engineer", location: "Remote", limit: 1 }, undefined, undefined, undefined as never);
  assert.deepEqual(calls[0], ["search", "--query", "backend engineer", "--limit", "1", "--format", "json", "--city", "Remote"]);
  await assert.rejects(() => tools.searchJobs.execute("empty", { query: "", location: "", limit: 1 }, undefined, undefined, undefined as never), /query|empty/i);
  await assert.rejects(() => tools.searchJobs.execute("long-location", { query: "backend", location: "x".repeat(121), limit: 1 }, undefined, undefined, undefined as never), /location|too long/i);
  await assert.rejects(() => tools.searchJobs.execute("bad-limit", { query: "backend", location: "", limit: 6 }, undefined, undefined, undefined as never), /limit|maximum/i);
  await assert.rejects(() => tools.searchJobs.execute("injected", { query: "backend --format json", location: "", limit: 1 }, undefined, undefined, undefined as never), /argument|flag|invalid/i);
  const freshTools = createScrapeTools({ runCli: async (args) => { calls.push(args); return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) }; } });
  await assert.rejects(() => freshTools.searchJobs.execute("injected-location", { query: "backend", location: "Remote --format json", limit: 1 }, undefined, undefined, undefined as never), /argument|flag|invalid/i);
  await assert.rejects(() => tools.fetchJobDetails.execute("bad", { resultId: "../escape" }, undefined, undefined, undefined as never), /resultId|invalid/i);
  await assert.rejects(() => tools.fetchJobDetails.execute("before-search", { resultId: "not-searched" }, undefined, undefined, undefined as never), /was not returned/i);
});

test("scrape upsert preserves every advanced stage while refreshing posting data", () => {
  const stages = ["Selected", "Drafting", "Ready", "Applied", "Interview", "Offer", "Rejected", "Archived"] as const;
  const db = openDatabase(":memory:");
  try {
    for (const [index, stage] of stages.entries()) {
      const sourceId = `advanced-${index}`;
      const url = `https://example.test/advanced/${index}`;
      db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,location,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        `job-${index}`, sourceId, "freehire", url, "Old Example", "Old Role", "Old Location", "old posting", 10,
        JSON.stringify({ reason: "old", strengths: [], gaps: [] }), stage, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      );
      persistScrape(db, result([scrapeJob(sourceId, url)]), 60, "2026-02-01T00:00:00.000Z", 1);
      const row = db.prepare("SELECT stage,company,role,posting,score FROM jobs WHERE id=?").get(`job-${index}`) as { stage: string; company: string; role: string; posting: string; score: number };
      assert.equal(row.stage, stage);
      assert.equal(row.company, "Example");
      assert.equal(row.role, "Backend Engineer");
      assert.equal(row.posting, "TypeScript Kubernetes");
      assert.equal(row.score, 81);
    }
  } finally { db.close(); }
});

test("document status reports actual templates and bounded executable checks", async () => {
  const db = openDatabase(":memory:");
  const calls: string[][] = [];
  const app = await buildServer({ db, projectRoot: process.cwd(), documentStatusRunner: async (executable, args) => { calls.push([executable, ...args]); return { code: 0, stdout: "", stderr: "" }; } });
  try {
    const response = await app.inject({ url: "/api/document-status" });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { tools: Record<string, { available: boolean }>; templates: { cv: { available: boolean; names: string[] }; coverLetter: { available: boolean } } };
    assert.equal(body.tools.lualatex.available, true);
    assert.equal(body.tools.pdftotext.available, true);
    assert.equal(body.templates.cv.available, true);
    assert.deepEqual(body.templates.cv.names, ["backend_java_spring"]);
    assert.deepEqual(calls, [["lualatex", "--version"], ["xelatex", "--version"], ["pdfinfo", "-v"], ["pdftotext", "-v"]]);
  } finally { await app.close(); db.close(); }
});
