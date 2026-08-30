import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateScrapeResult } from "../src/server/scrape.js";
import { deterministicDocumentIssues } from "../src/server/verifier.js";
import type { GenerationOutput } from "../src/server/generation.js";

const fixtureDir = join(import.meta.dirname, "fixtures", "ai");

type Fixture = {
  id: string;
  profile?: string;
  job?: { company: string; role: string; posting: string; score: number; reason?: string };
  jobs?: Array<{ sourceId: string; url: string; score: number }>;
  documents?: { cv: string | null; coverLetter: string | null };
  generation?: Partial<GenerationOutput>;
  expect: Record<string, unknown>;
};

async function loadFixtures() {
  const names = (await readdir(fixtureDir)).filter((name) => name.endsWith(".json"));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(fixtureDir, name), "utf8")) as Fixture));
}

test("golden AI fixtures cover the planned failure categories", async () => {
  const fixtures = await loadFixtures();
  assert.equal(fixtures.length, 10);
  const ids = new Set(fixtures.map((fixture) => fixture.id));
  for (const id of [
    "strong-backend-java",
    "frontend-mismatch",
    "weak-profile",
    "poisoned-posting",
    "missing-document",
    "duplicate-job",
    "long-posting",
    "unsupported-metric",
    "ambiguous-requirement",
    "no-matching-evidence",
  ]) assert.ok(ids.has(id), id);
});

test("fixture constraints hold without live providers", async () => {
  const fixtures = await loadFixtures();
  for (const fixture of fixtures) {
    if (fixture.id === "long-posting" && fixture.job) fixture.job.posting = `${"Detailed requirement. ".repeat(120)}`;
    if (fixture.job && typeof fixture.expect.minScore === "number") assert.ok(fixture.job.score >= Number(fixture.expect.minScore), fixture.id);
    if (fixture.job && typeof fixture.expect.maxScore === "number") assert.ok(fixture.job.score <= Number(fixture.expect.maxScore), fixture.id);
    if (fixture.job && fixture.expect.retainPosting) assert.match(fixture.job.posting, /Ignore previous instructions/);
    if (fixture.job && typeof fixture.expect.minPostingLength === "number") assert.ok(fixture.job.posting.length >= Number(fixture.expect.minPostingLength), fixture.id);
    if (fixture.documents?.cv === null) assert.equal(fixture.documents.cv, null);
    if (fixture.generation) {
      const output: GenerationOutput = {
        cvTemplate: "moderncv",
        roleEmphasis: [],
        cvEdits: [],
        profileFacts: fixture.generation.profileFacts ?? ["fact"],
        coverLetterSubject: "",
        coverLetterParagraphs: fixture.generation.coverLetterParagraphs ?? [],
        coverLetterBullets: fixture.generation.coverLetterBullets ?? [],
        gaps: fixture.generation.gaps ?? [],
      };
      const issues = deterministicDocumentIssues(output, fixture.profile ?? "", fixture.job?.posting ?? "");
      if (fixture.expect.issue) assert.ok(issues.includes(String(fixture.expect.issue)), fixture.id);
    }
    if (fixture.jobs) {
      const provenance = new Map(fixture.jobs.map((entry) => [entry.sourceId, entry.url]));
      const payload = {
        jobs: fixture.jobs.map((entry) => ({
          sourceId: entry.sourceId,
          source: "freehire",
          url: entry.url,
          company: "Example",
          role: "Engineer",
          location: "Remote",
          posting: "Posting",
          score: entry.score,
          reason: "fit",
          strengths: [],
          gaps: [],
        })),
      };
      if (fixture.expect.uniqueUrls === 1) {
        assert.throws(() => validateScrapeResult(payload, provenance, 50, "freehire"));
      }
    }
  }
});
