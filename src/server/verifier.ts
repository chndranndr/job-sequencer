import { z } from "zod";
import type { TrajectoryEventInput, TrajectoryRecorder } from "../shared.js";
import type { ScrapeResult } from "./scrape.js";
import type { GenerationOutput } from "./generation.js";

// ponytail: rank verifier checks top 5 with 15-point disagreement threshold; tune only after labeled ranking eval.
export const rankVerifierTopN = 5;
export const rankVerifierDisagreementThreshold = 15;
// ponytail: document second opinion is disabled by default to avoid doubling provider cost; enable for final/high-stakes artifacts.
export const documentVerifierEnv = "DOCUMENT_VERIFIER_STRICT";
export const rankVerifierEnv = "RANK_VERIFIER_STRICT";

const RankVerifierEntrySchema = z.object({
  sourceId: z.string().min(1),
  score: z.number().int().min(0).max(100),
  reason: z.string().max(500),
}).strict();

export const RankVerifierOutputSchema = z.object({
  results: z.array(RankVerifierEntrySchema).max(rankVerifierTopN),
}).strict();

export type RankVerifierOutput = z.infer<typeof RankVerifierOutputSchema>;

export const DocumentVerifierOutputSchema = z.object({
  needsReview: z.boolean(),
  issues: z.array(z.string().max(300)).max(20),
}).strict();

export type DocumentVerifierOutput = z.infer<typeof DocumentVerifierOutputSchema>;

export type VerifierStatus = "skipped" | "passed" | "warning" | "needs_review" | "failed";

export type RankVerifierResult = {
  status: VerifierStatus;
  needsReview: string[];
  disagreements: Array<{ sourceId: string; primaryScore: number; verifiedScore: number; delta: number }>;
  primary: ScrapeResult;
};

export type DocumentVerifierResult = {
  status: VerifierStatus;
  needsReview: boolean;
  issues: string[];
  primary: GenerationOutput;
};

function record(trajectory: TrajectoryRecorder | undefined, runId: string | undefined, event: TrajectoryEventInput) {
  if (!runId || !trajectory) return;
  try { trajectory(runId, event); } catch { /* telemetry is deliberately non-fatal */ }
}

export function isRankVerifierEnabled() {
  return process.env[rankVerifierEnv] === "1";
}

export function isDocumentVerifierEnabled() {
  return process.env[documentVerifierEnv] === "1";
}

export function scoreDisagreement(primary: number, verified: number) {
  return Math.abs(primary - verified);
}

export function computeRankDisagreements(
  jobs: ScrapeResult["jobs"],
  verified: RankVerifierOutput,
  threshold = rankVerifierDisagreementThreshold,
) {
  const byId = new Map(verified.results.map((entry) => [entry.sourceId, entry]));
  const disagreements: RankVerifierResult["disagreements"] = [];
  const needsReview: string[] = [];
  for (const job of jobs.slice(0, rankVerifierTopN)) {
    const match = byId.get(job.sourceId);
    if (!match) {
      needsReview.push(job.sourceId);
      continue;
    }
    const delta = scoreDisagreement(job.score, match.score);
    if (delta >= threshold) {
      disagreements.push({ sourceId: job.sourceId, primaryScore: job.score, verifiedScore: match.score, delta });
      needsReview.push(job.sourceId);
    }
  }
  return { disagreements, needsReview };
}

export async function runRankVerifier(input: {
  result: ScrapeResult;
  enabled?: boolean;
  execute?: () => Promise<unknown>;
  trajectory?: TrajectoryRecorder;
  runId?: string;
}): Promise<RankVerifierResult> {
  const enabled = input.enabled ?? isRankVerifierEnabled();
  if (!enabled) {
    return { status: "skipped", needsReview: [], disagreements: [], primary: input.result };
  }
  if (!input.execute) {
    record(input.trajectory, input.runId, { kind: "lifecycle", type: "verifier_skipped", payload: { verifier: "rank", reason: "no_execute" } });
    return { status: "skipped", needsReview: [], disagreements: [], primary: input.result };
  }

  record(input.trajectory, input.runId, { kind: "lifecycle", type: "verifier_started", payload: { verifier: "rank", topN: rankVerifierTopN } });
  try {
    const raw = await input.execute();
    let verified: RankVerifierOutput;
    try {
      verified = RankVerifierOutputSchema.parse(raw);
    } catch (error) {
      record(input.trajectory, input.runId, { kind: "error", type: "verifier_failed", payload: { verifier: "rank", error: error instanceof Error ? error.message : String(error) } });
      return { status: "warning", needsReview: [], disagreements: [], primary: input.result };
    }
    const { disagreements, needsReview } = computeRankDisagreements(input.result.jobs, verified);
    const status: VerifierStatus = needsReview.length ? "needs_review" : "passed";
    record(input.trajectory, input.runId, {
      kind: status === "needs_review" ? "lifecycle" : "lifecycle",
      type: status === "needs_review" ? "verifier_needs_review" : "verifier_completed",
      payload: { verifier: "rank", disagreements, needsReview, status },
    });
    return { status, needsReview, disagreements, primary: input.result };
  } catch (error) {
    record(input.trajectory, input.runId, { kind: "error", type: "verifier_failed", payload: { verifier: "rank", error: error instanceof Error ? error.message : String(error) } });
    return { status: "warning", needsReview: [], disagreements: [], primary: input.result };
  }
}

const genericAiPhrases = /\b(as an ai|language model|i cannot|delve into|synergy|leverage best practices)\b/i;

export function deterministicDocumentIssues(output: GenerationOutput, profile: string, jobContext: string) {
  const issues: string[] = [];
  const corpus = [
    ...(output.coverLetterParagraphs ?? []),
    ...(output.coverLetterBullets ?? []),
    ...(output.roleEmphasis ?? []),
    ...(output.cvEdits ?? []),
  ].join("\n");
  if (genericAiPhrases.test(corpus)) issues.push("generic_ai_language");
  const metricPattern = /\d{1,3}%|\b\d+x\b/;
  if (metricPattern.test(corpus) && !metricPattern.test(profile) && !metricPattern.test(jobContext)) issues.push("unsupported_metric");
  const paragraphSet = new Set((output.coverLetterParagraphs ?? []).map((value) => value.trim().toLowerCase()));
  if ((output.coverLetterBullets ?? []).some((bullet) => paragraphSet.has(bullet.trim().toLowerCase()))) issues.push("repeated_paragraph_bullet");
  return issues;
}

export async function runDocumentVerifier(input: {
  output: GenerationOutput;
  profile: string;
  jobContext: string;
  enabled?: boolean;
  execute?: () => Promise<unknown>;
  trajectory?: TrajectoryRecorder;
  runId?: string;
}): Promise<DocumentVerifierResult> {
  const issues = deterministicDocumentIssues(input.output, input.profile, input.jobContext);
  const enabled = input.enabled ?? isDocumentVerifierEnabled();
  if (!enabled) {
    return { status: issues.length ? "warning" : "skipped", needsReview: issues.length > 0, issues, primary: input.output };
  }
  if (!input.execute) {
    record(input.trajectory, input.runId, { kind: "lifecycle", type: "verifier_skipped", payload: { verifier: "document", reason: "no_execute" } });
    return { status: issues.length ? "warning" : "skipped", needsReview: issues.length > 0, issues, primary: input.output };
  }

  record(input.trajectory, input.runId, { kind: "lifecycle", type: "verifier_started", payload: { verifier: "document" } });
  try {
    const raw = await input.execute();
    let verified: DocumentVerifierOutput;
    try {
      verified = DocumentVerifierOutputSchema.parse(raw);
    } catch (error) {
      record(input.trajectory, input.runId, { kind: "error", type: "verifier_failed", payload: { verifier: "document", error: error instanceof Error ? error.message : String(error) } });
      return { status: "warning", needsReview: issues.length > 0, issues, primary: input.output };
    }
    const merged = [...new Set([...issues, ...verified.issues])];
    const needsReview = verified.needsReview || merged.length > 0;
    const status: VerifierStatus = needsReview ? "needs_review" : "passed";
    record(input.trajectory, input.runId, {
      kind: "lifecycle",
      type: needsReview ? "verifier_needs_review" : "verifier_completed",
      payload: { verifier: "document", issues: merged, status },
    });
    return { status, needsReview, issues: merged, primary: input.output };
  } catch (error) {
    record(input.trajectory, input.runId, { kind: "error", type: "verifier_failed", payload: { verifier: "document", error: error instanceof Error ? error.message : String(error) } });
    return { status: "warning", needsReview: issues.length > 0, issues, primary: input.output };
  }
}
