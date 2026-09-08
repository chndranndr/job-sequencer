import type { DatabaseSync } from "node:sqlite";
import type { JobSource } from "../../shared.js";
import { normalizePromptText } from "../context.js";

const maxHistoricalSourceLength = 64;
const maxHistoricalQueryLength = 160;
const maxHistoricalLocationLength = 120;
const maxHistoricalRoleLength = 160;

function normalizeHistoricalValue(value: unknown, maxLength: number) {
  const normalized = normalizePromptText(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, maxLength);
}
function historicalSourceFilter(enabledSources: readonly JobSource[] | undefined): { sql: string; values: string[] } {
  if (enabledSources === undefined) return { sql: "", values: [] };
  const values = [...new Set(enabledSources.map(source => String(source)))];
  return values.length
    ? { sql: `WHERE source IN (${values.map(() => "?").join(",")})`, values }
    : { sql: "WHERE 1 = 0", values: [] };
}


export interface HistoricalSearchSignal {
  pattern: string;
  signal: "positive" | "negative" | "neutral";
  evidence: string;
  confidence: number;
  lastAttemptedAt?: string;
  attemptCount: number;
  promisingCount: number;
  uniqueCount: number;
  duplicateCount: number;
}

export interface PreferenceSignal {
  pattern: string;
  positive: number;
  negative: number;
  confidence: number;
  evidenceCount: number;
}

export interface SourcePerformanceSummary {
  source: string;
  attempts: number;
  successRate: number;
  averageYield: number;
  duplicateRate: number;
  promisingJobs: number;
  lastAttemptedAt?: string;
}

export interface CompiledSearchMemory {
  historicalSearchSignals: HistoricalSearchSignal[];
  preferenceSignals: PreferenceSignal[];
  sourceSummaries: SourcePerformanceSummary[];
  summaryText: string;
}

export interface CompileSearchMemoryOptions {
  enabledSources?: JobSource[];
  maxRecentAttempts?: number;
  maxSignals?: number;
  maxPreferenceSignals?: number;
  maxTextLength?: number;
}

export function aggregateSourcePerformance(
  db: DatabaseSync,
  options: { maxRecentAttempts?: number; enabledSources?: JobSource[] } = {},
): SourcePerformanceSummary[] {
  const limit = Math.max(1, Math.min(options.maxRecentAttempts ?? 100, 500));
  const sourceFilter = historicalSourceFilter(options.enabledSources);
  const rows = db.prepare(`
    SELECT source, status, unique_result_count, promising_result_count,
           duplicate_count, result_count, created_at
    FROM search_attempts
    ${sourceFilter.sql}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...sourceFilter.values, limit) as Array<Record<string, unknown>>;
  const enabledSet = options.enabledSources ? new Set(options.enabledSources) : null;
  const summaries = new Map<string, {
    attempts: number;
    completed: number;
    unique: number;
    promising: number;
    duplicates: number;
    results: number;
    lastAttemptedAt?: string;
  }>();

  for (const row of rows) {
    const source = normalizeHistoricalValue(row.source, maxHistoricalSourceLength);
    if (!source || (enabledSet && !enabledSet.has(source as JobSource))) continue;
    const current = summaries.get(source) ?? { attempts: 0, completed: 0, unique: 0, promising: 0, duplicates: 0, results: 0 };
    current.attempts += 1;
    current.completed += row.status === "completed" ? 1 : 0;
    current.unique += Number(row.unique_result_count ?? 0);
    current.promising += Number(row.promising_result_count ?? 0);
    current.duplicates += Number(row.duplicate_count ?? 0);
    current.results += Number(row.result_count ?? 0);
    const createdAt = row.created_at ? String(row.created_at) : undefined;
    if (createdAt && (!current.lastAttemptedAt || createdAt > current.lastAttemptedAt)) current.lastAttemptedAt = createdAt;
    summaries.set(source, current);
  }

  return [...summaries.entries()]
    .sort(([left, leftValue], [right, rightValue]) => rightValue.attempts - leftValue.attempts || left.localeCompare(right))
    .map(([source, summary]) => ({
      source,
      attempts: summary.attempts,
      successRate: Number((summary.completed / summary.attempts).toFixed(2)),
      averageYield: Number(((summary.unique + summary.promising) / summary.attempts).toFixed(2)),
      duplicateRate: summary.results > 0 ? Number((summary.duplicates / summary.results).toFixed(2)) : 0,
      promisingJobs: summary.promising,
      lastAttemptedAt: summary.lastAttemptedAt,
    }));
}

export function deriveHistoricalSearchSignals(
  db: DatabaseSync,
  options: { maxRecentAttempts?: number; maxSignals?: number; enabledSources?: readonly JobSource[] } = {},
): HistoricalSearchSignal[] {
  const limit = Math.max(1, Math.min(options.maxRecentAttempts ?? 100, 500));
  const maxSignals = Math.max(1, Math.min(options.maxSignals ?? 6, 20));
  const sourceFilter = historicalSourceFilter(options.enabledSources);

  const rows = db.prepare(`
    SELECT source, query, location, status, unique_result_count,
           promising_result_count, duplicate_count, result_count, created_at
    FROM search_attempts
    ${sourceFilter.sql}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...sourceFilter.values, limit) as Array<Record<string, unknown>>;
  const aggregates = new Map<string, {
    source: string;
    query: string;
    location: string;
    attempts: number;
    completed: number;
    unique: number;
    promising: number;
    duplicates: number;
    results: number;
    lastAttemptedAt?: string;
  }>();

  for (const row of rows) {
    const source = normalizeHistoricalValue(row.source, maxHistoricalSourceLength);
    const query = normalizeHistoricalValue(row.query, maxHistoricalQueryLength);
    const location = normalizeHistoricalValue(row.location, maxHistoricalLocationLength);
    if (!source || !query) continue;
    const key = `${source}\u0000${query}\u0000${location}`;
    const current = aggregates.get(key) ?? { source, query, location, attempts: 0, completed: 0, unique: 0, promising: 0, duplicates: 0, results: 0 };
    current.attempts += 1;
    current.completed += row.status === "completed" ? 1 : 0;
    current.unique += Number(row.unique_result_count ?? 0);
    current.promising += Number(row.promising_result_count ?? 0);
    current.duplicates += Number(row.duplicate_count ?? 0);
    current.results += Number(row.result_count ?? 0);
    const createdAt = row.created_at ? String(row.created_at) : undefined;
    if (createdAt && (!current.lastAttemptedAt || createdAt > current.lastAttemptedAt)) current.lastAttemptedAt = createdAt;
    aggregates.set(key, current);
  }

  const candidates: HistoricalSearchSignal[] = [];

  for (const row of [...aggregates.values()].sort((left, right) =>
    right.attempts - left.attempts || (right.lastAttemptedAt ?? "").localeCompare(left.lastAttemptedAt ?? ""),
  )) {
    const { attempts, completed, unique, promising, duplicates, results, source, query, location, lastAttemptedAt } = row;
    const pattern = `${query}${location ? ` / ${location}` : ""} / ${source}`;
    const confidence = Number((attempts / (attempts + 2)).toFixed(2));

    let signal: "positive" | "negative" | "neutral" = "neutral";
    let evidence = "";

    if (promising >= 2 || (promising >= 1 && unique >= 2 && duplicates <= unique)) {
      signal = "positive";
      evidence = `higher unique/promising yield across recent runs (${promising} promising, ${unique} unique across ${attempts} attempt(s))`;
    } else if ((attempts >= 2 && unique === 0) || (results > 0 && duplicates / results >= 0.7 && unique === 0)) {
      signal = "negative";
      evidence = `high duplicate or low useful yield (${duplicates} duplicate(s), ${unique} unique across ${attempts} attempt(s))`;
    } else if (completed === 0 && attempts >= 2) {
      signal = "negative";
      evidence = `repeated search failures across ${attempts} attempt(s)`;
    } else {
      evidence = `moderate yield (${promising} promising, ${unique} unique across ${attempts} attempt(s))`;
    }

    candidates.push({
      pattern,
      signal,
      evidence,
      confidence,
      lastAttemptedAt,
      attemptCount: attempts,
      promisingCount: promising,
      uniqueCount: unique,
      duplicateCount: duplicates,
    });
  }

  const positive = candidates
    .filter((s) => s.signal === "positive")
    .sort((a, b) => b.confidence - a.confidence || b.promisingCount - a.promisingCount)
    .slice(0, Math.ceil(maxSignals / 2));

  const negative = candidates
    .filter((s) => s.signal === "negative")
    .sort((a, b) => b.confidence - a.confidence || b.duplicateCount - a.duplicateCount)
    .slice(0, Math.ceil(maxSignals / 2));

  const neutrals = candidates
    .filter((s) => s.signal === "neutral")
    .slice(0, Math.max(0, maxSignals - (positive.length + negative.length)));

  return [...positive, ...negative, ...neutrals].slice(0, maxSignals);
}

export function derivePreferenceSignals(
  db: DatabaseSync,
  options: { maxSignals?: number } = {},
): PreferenceSignal[] {
  const maxSignals = Math.max(1, Math.min(options.maxSignals ?? 6, 20));

  const rows = db.prepare(`
    SELECT j.role, j.location, j.company, j.stage, j.score, a.outcome
    FROM jobs j
    LEFT JOIN applications a ON a.job_id = j.id
    ORDER BY j.updated_at DESC
    LIMIT 200
  `).all() as Array<{
    role: string;
    location: string;
    company: string;
    stage: string;
    score: number;
    outcome: string | null;
  }>;

  const patterns = new Map<string, { positive: number; negative: number }>();

  function tally(pattern: string, isPositive: boolean, weight = 1) {
    const key = pattern.trim();
    if (!key || key.length < 2) return;
    const current = patterns.get(key) ?? { positive: 0, negative: 0 };
    if (isPositive) current.positive += weight;
    else current.negative += weight;
    patterns.set(key, current);
  }

  for (const row of rows) {
    const stage = row.stage;
    const outcome = (row.outcome ?? "").toLowerCase();

    const isPositive = ["Selected", "Drafting", "Ready", "Applied", "Interview", "Offer"].includes(stage) ||
      outcome.includes("interview") || outcome.includes("offer");

    const isNegative = stage === "Discarded" || stage === "Rejected" ||
      outcome.includes("rejected");

    if (!isPositive && !isNegative) continue;

    const weight = (stage === "Interview" || stage === "Offer" || outcome.includes("interview") || outcome.includes("offer")) ? 2 : 1;
    const role = normalizeHistoricalValue(row.role, maxHistoricalRoleLength);
    const location = normalizeHistoricalValue(row.location, maxHistoricalLocationLength);

    if (role) tally(role, isPositive, weight);
    if (location && location.toLowerCase() !== "remote") tally(location, isPositive, weight);
  }

  const results: PreferenceSignal[] = [];

  for (const [pattern, counts] of patterns.entries()) {
    const evidenceCount = counts.positive + counts.negative;
    if (evidenceCount < 1) continue;
    const confidence = Number((evidenceCount / (evidenceCount + 2)).toFixed(2));
    results.push({
      pattern,
      positive: counts.positive,
      negative: counts.negative,
      confidence,
      evidenceCount,
    });
  }

  return results
    .sort((a, b) => {
      const aNet = (a.positive - a.negative) / a.evidenceCount;
      const bNet = (b.positive - b.negative) / b.evidenceCount;
      return b.confidence * bNet - a.confidence * aNet || b.evidenceCount - a.evidenceCount;
    })
    .slice(0, maxSignals);
}

export function compileSearchMemory(
  db: DatabaseSync,
  options: CompileSearchMemoryOptions = {},
): CompiledSearchMemory {
  const maxTextLength = Math.max(200, Math.min(options.maxTextLength ?? 1500, 5000));
  const historicalSearchSignals = deriveHistoricalSearchSignals(db, {
    maxRecentAttempts: options.maxRecentAttempts,
    maxSignals: options.maxSignals,
    enabledSources: options.enabledSources,
  });

  const preferenceSignals = derivePreferenceSignals(db, {
    maxSignals: options.maxPreferenceSignals,
  });

  const sourceSummaries = aggregateSourcePerformance(db, {
    maxRecentAttempts: options.maxRecentAttempts,
    enabledSources: options.enabledSources,
  });

  const hasHistory = historicalSearchSignals.length > 0 || preferenceSignals.length > 0 || sourceSummaries.length > 0;

  if (!hasHistory) {
    return {
      historicalSearchSignals: [],
      preferenceSignals: [],
      sourceSummaries: [],
      summaryText: "No prior search history or outcome signals recorded yet.",
    };
  }

  const sections: string[] = [];

  if (historicalSearchSignals.length > 0) {
    const lines = historicalSearchSignals.map(
      (s) => `- [${s.signal.toUpperCase()}] ${s.pattern} (confidence: ${s.confidence}): ${s.evidence}`,
    );
    sections.push(`HISTORICAL SEARCH SIGNALS:\n${lines.join("\n")}`);
  }

  if (preferenceSignals.length > 0) {
    const lines = preferenceSignals.map(
      (p) => `- ${p.pattern}: +${p.positive} / -${p.negative} (confidence: ${p.confidence}, evidence: ${p.evidenceCount})`,
    );
    sections.push(`BEHAVIORAL PREFERENCE SIGNALS:\n${lines.join("\n")}`);
  }

  if (sourceSummaries.length > 0) {
    const lines = sourceSummaries.map(
      (s) => `- ${s.source}: ${s.attempts} attempt(s), ${Math.round(s.successRate * 100)}% success rate, ${s.averageYield} avg yield, ${Math.round(s.duplicateRate * 100)}% duplicate rate`,
    );
    sections.push(`SOURCE PERFORMANCE SUMMARIES:\n${lines.join("\n")}`);
  }

  let summaryText = sections.join("\n\n");
  if (summaryText.length > maxTextLength) {
    summaryText = `${summaryText.slice(0, maxTextLength - 32)}...\n[bounded historical memory]`;
  }

  return {
    historicalSearchSignals,
    preferenceSignals,
    sourceSummaries,
    summaryText,
  };
}
