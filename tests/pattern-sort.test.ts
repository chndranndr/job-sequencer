import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../src/shared.js";
import { sortPatternJobs } from "../src/tracker/pattern-sort.js";

const NOW = Date.parse("2026-08-27T00:00:00.000Z");

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    source_id: id,
    source: "freehire",
    url: `https://example.test/${id}`,
    company: "Company",
    role: "Role",
    location: "Remote",
    posting: "Posting",
    score: 50,
    stage: "Recommended",
    rank: { reason: "", strengths: [], gaps: [] },
    notes: "",
    first_seen_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

test("pattern sorting preserves API order, is stable, and does not mutate jobs", () => {
  const jobs = [
    job("tie-first", { score: 50 }),
    job("high", { score: 90 }),
    job("invalid", { score: Number.NaN }),
    job("tie-second", { score: 50 }),
  ];
  const original = jobs.slice();

  assert.deepEqual(sortPatternJobs(jobs, null, "ascending", NOW), jobs);
  assert.deepEqual(sortPatternJobs(jobs, "fit", "ascending", NOW).map(({ id }) => id), ["tie-first", "tie-second", "high", "invalid"]);
  assert.deepEqual(sortPatternJobs(jobs, "fit", "descending", NOW).map(({ id }) => id), ["high", "tie-first", "tie-second", "invalid"]);
  assert.deepEqual(jobs, original);
});

test("pattern sorting compares SAMPLE by company then role and other text columns case-insensitively", () => {
  const sampleJobs = [
    job("zulu", { company: "Acme", role: "Zulu" }),
    job("alpha", { company: "acme", role: "Alpha" }),
    job("beta", { company: "Beta", role: "Role" }),
  ];
  assert.deepEqual(sortPatternJobs(sampleJobs, "sample", "ascending", NOW).map(({ id }) => id), ["alpha", "zulu", "beta"]);

  const signalJobs = [
    job("jvm", { role: "Java developer" }),
    job("go", { role: "Go developer" }),
    job("fit", { role: "Generalist" }),
  ];
  assert.deepEqual(sortPatternJobs(signalJobs, "sig", "ascending", NOW).map(({ id }) => id), ["fit", "go", "jvm"]);

  const stageJobs = [
    job("ready", { stage: "Ready" }),
    job("applied", { stage: "Applied" }),
    job("recommended", { stage: "Recommended" }),
  ];
  assert.deepEqual(sortPatternJobs(stageJobs, "fx", "ascending", NOW).map(({ id }) => id), ["applied", "ready", "recommended"]);

  const sourceJobs = [
    job("manual", { source: "manual" }),
    job("linkedin", { source: "linkedin" }),
    job("freehire", { source: "freehire" }),
  ];
  assert.deepEqual(sortPatternJobs(sourceJobs, "src", "ascending", NOW).map(({ id }) => id), ["freehire", "linkedin", "manual"]);
});

test("pattern sorting compares AGE numerically", () => {
  const jobs = [
    job("ten-days", { first_seen_at: "2026-08-17T00:00:00.000Z" }),
    job("two-days", { first_seen_at: "2026-08-25T00:00:00.000Z" }),
  ];

  assert.deepEqual(sortPatternJobs(jobs, "age", "ascending", NOW).map(({ id }) => id), ["two-days", "ten-days"]);
  assert.deepEqual(sortPatternJobs(jobs, "age", "descending", NOW).map(({ id }) => id), ["ten-days", "two-days"]);
});
