import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRankDisagreements,
  deterministicDocumentIssues,
  runDocumentVerifier,
  runRankVerifier,
  scoreDisagreement,
} from "../src/server/verifier.js";
import type { GenerationOutput } from "../src/server/generation.js";

const job = (sourceId: string, score: number) => ({
  sourceId,
  source: "freehire",
  url: `https://example.test/${sourceId}`,
  company: "Example",
  role: "Engineer",
  location: "Remote",
  posting: "Build APIs",
  score,
  reason: "fit",
  strengths: [],
  gaps: [],
});

test("score disagreement is calculated for top-N rank checks", () => {
  assert.equal(scoreDisagreement(80, 62), 18);
  const { disagreements, needsReview } = computeRankDisagreements(
    [job("a", 80), job("b", 70)],
    { results: [{ sourceId: "a", score: 60, reason: "weak" }, { sourceId: "b", score: 68, reason: "ok" }] },
    15,
  );
  assert.equal(disagreements.length, 1);
  assert.deepEqual(needsReview, ["a"]);
});

test("malformed rank verifier output does not erase primary scrape results", async () => {
  const primary = { jobs: [job("a", 81)] };
  const events: Array<{ type: string }> = [];
  const result = await runRankVerifier({
    result: primary,
    enabled: true,
    execute: async () => ({ results: [{ sourceId: "a", score: "bad" }] }),
    trajectory: (_runId, event) => { events.push(event); },
    runId: "verify-rank",
  });
  assert.deepEqual(result.primary, primary);
  assert.equal(result.status, "warning");
  assert.ok(events.some((event) => event.type === "verifier_failed"));
});

test("rank verifier failure records needs_review without mutating primary output", async () => {
  const primary = { jobs: [job("a", 90)] };
  const result = await runRankVerifier({
    result: primary,
    enabled: true,
    execute: async () => ({ results: [{ sourceId: "a", score: 50, reason: "mismatch" }] }),
    runId: "verify-rank-2",
  });
  assert.equal(result.primary.jobs[0]?.score, 90);
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.needsReview, ["a"]);
});

test("rank verifier calls are skipped when disabled", async () => {
  let calls = 0;
  const result = await runRankVerifier({
    result: { jobs: [job("a", 80)] },
    enabled: false,
    execute: async () => { calls += 1; return { results: [] }; },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "skipped");
});

test("document verifier keeps primary output and flags deterministic issues", async () => {
  const output: GenerationOutput = {
    cvTemplate: "moderncv",
    roleEmphasis: [],
    cvEdits: [],
    profileFacts: ["Backend engineer with Java experience"],
    coverLetterSubject: "",
    coverLetterParagraphs: ["As an AI language model I improved throughput by 99%."],
    coverLetterBullets: [],
    gaps: [],
  };
  const issues = deterministicDocumentIssues(output, "Backend engineer with Java experience", "Java backend role");
  assert.ok(issues.includes("generic_ai_language"));
  const result = await runDocumentVerifier({
    output,
    profile: "Backend engineer with Java experience",
    jobContext: "Java backend role",
    enabled: false,
  });
  assert.equal(result.primary, output);
  assert.equal(result.needsReview, true);
});

test("malformed document verifier output does not erase primary generation output", async () => {
  const output: GenerationOutput = {
    cvTemplate: "moderncv",
    roleEmphasis: [],
    cvEdits: [],
    profileFacts: ["Known fact"],
    coverLetterSubject: "",
    coverLetterParagraphs: ["Grounded paragraph."],
    coverLetterBullets: [],
    gaps: [],
  };
  const result = await runDocumentVerifier({
    output,
    profile: "Known fact",
    jobContext: "Role",
    enabled: true,
    execute: async () => ({ needsReview: "yes", issues: 1 }),
  });
  assert.equal(result.primary, output);
  assert.equal(result.status, "warning");
});
