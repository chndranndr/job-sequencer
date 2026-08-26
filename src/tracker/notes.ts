import type { Job } from "../shared.js";

const NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"] as const;
const MIN_SCORE = 10;
const MAX_SCORE = 100;
const SEMITONES = 12;
const DAY_MS = 86_400_000;

const SIGNAL_PRIORITY: ReadonlyArray<readonly [string, RegExp]> = [
  ["JVM", /\b(?:java|jvm|spring|kotlin|scala)\b/i],
  ["GO", /\b(?:go|golang)\b/i],
  ["CLOUD", /\b(?:cloud|aws|azure|gcp|kubernetes|k8s|docker|terraform)\b/i],
  ["PLAT", /\b(?:platform|sre|devops|infrastructure|reliability)\b/i],
  ["AI", /\b(?:ai|ml|llm|genai|machine learning|artificial intelligence)\b/i],
  ["API", /\b(?:api|rest|graphql|microservices)\b/i],
  ["UI", /\b(?:ui|ux|frontend|front-end|react|vue|angular|javascript|typescript|web)\b/i],
  ["DATA", /\b(?:data|analytics|sql|etl|warehouse|spark)\b/i],
];

export function scoreToNote(score: number): string {
  if (!Number.isFinite(score)) return "---";
  const clamped = Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));
  const semitone = Math.round(((clamped - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)) * SEMITONES);
  return `${NAMES[semitone % NAMES.length]}${5 + Math.floor(semitone / NAMES.length)}`;
}

export function scoreToSignal(job: Pick<Job, "role" | "posting" | "rank">): string {
  const text = [job.role, job.posting, job.rank.reason, ...job.rank.strengths, ...job.rank.gaps].join(" ");
  return SIGNAL_PRIORITY.find(([, pattern]) => pattern.test(text))?.[0] ?? "FIT";
}

export function inboxAgeDays(firstSeenAt: string, now: number | string = Date.now()): number {
  const seen = Date.parse(firstSeenAt);
  const current = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(seen) || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.floor((current - seen) / DAY_MS));
}

export function rowHex(index: number): string {
  return (index & 0xff).toString(16).toUpperCase().padStart(2, "0");
}
