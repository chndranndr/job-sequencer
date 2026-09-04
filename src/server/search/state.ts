import { z } from "zod";
import { normalizeUrl } from "../db.js";
import { CriteriaSchema } from "../config.js";
import type { Criteria, JobSource, SearchBudget, SearchGoal, SearchHit, TrajectoryEventInput, TrajectoryRecorder } from "../../shared.js";

const provenanceSeparator = "\u0000";

export function searchProvenanceKey(source: JobSource, sourceId: string) {
  return `${source}${provenanceSeparator}${sourceId}`;
}

export const SearchBudgetSchema = z.object({
  maxSearchCalls: z.number().int().min(0).max(100),
  maxDetailCalls: z.number().int().min(0).max(100),
  maxTotalResults: z.number().int().min(0).max(500),
  maxRunDurationMs: z.number().int().min(0).max(3_600_000),
}).strict();

export const defaultSearchBudget: SearchBudget = Object.freeze({
  maxSearchCalls: 5,
  maxDetailCalls: 50,
  maxTotalResults: 50,
  maxRunDurationMs: 120_000,
});

export function createSearchBudget(value: Partial<SearchBudget> = {}): SearchBudget {
  return Object.freeze(SearchBudgetSchema.parse({ ...defaultSearchBudget, ...value })) as SearchBudget;
}

export function resolveSearchBudget(value: Partial<SearchBudget> | SearchBudget = {}, maxJobs = 50): SearchBudget {
  const boundedMaxJobs = z.number().int().min(0).max(500).parse(maxJobs);
  return createSearchBudget({ maxDetailCalls: boundedMaxJobs, maxTotalResults: boundedMaxJobs, ...value });
}

export type SearchAttempt = {
  operation: "search" | "detail";
  status: "started" | "completed" | "failed" | "rejected";
  source: JobSource;
  query?: string;
  location?: string;
  resultId?: string;
  requestedLimit?: number;
  resultCount?: number;
  uniqueResultCount?: number;
  cached?: boolean;
  error?: string;
  startedAt: string;
  endedAt?: string;
};

export type SearchSourceStats = {
  searchCalls: number;
  detailCalls: number;
  discoveredCount: number;
  uniqueCount: number;
  enrichedCount: number;
  errors: number;
};

export type SearchBudgetRemaining = {
  maxSearchCalls: number;
  maxDetailCalls: number;
  maxTotalResults: number;
  maxRunDurationMs: number;
};

export type SearchTermination = {
  reason: string;
  unresolvedGoals: string[];
  finishedAt: string;
};

export type AgentSearchSnapshot = {
  goal: SearchGoal;
  attempts: SearchAttempt[];
  sourceStats: Record<string, SearchSourceStats>;
  hits: SearchHit[];
  uniqueJobs: SearchHit[];
  enriched: Array<{ source: JobSource; sourceId: string }>;
  counts: { unique: number; discovered: number; enriched: number };
  uniqueCount: number;
  discoveredCount: number;
  enrichedCount: number;
  remaining: SearchBudgetRemaining;
  remainingSearchCalls: number;
  remainingDetailCalls: number;
  remainingResultSlots: number;
  remainingTimeMs: number;
  provenanceCount: number;
  termination: SearchTermination | null;
};

export type SearchStateOptions = {
  now?: () => number;
  runId?: string;
  trajectory?: TrajectoryRecorder;
};

export type SearchReservation = {
  token: number;
  source: JobSource;
  query: string;
  location: string;
  limit: number;
  attemptIndex: number;
};

export type DetailReservation = {
  token: number;
  source: JobSource;
  sourceId: string;
  resultId: string;
  hit: SearchHit;
  cached: boolean;
  attemptIndex: number;
};

export class SearchBudgetExceededError extends Error {
  constructor(public readonly operation: "search" | "detail", public readonly reason: "maxSearchCalls" | "maxDetailCalls" | "maxTotalResults" | "maxRunDurationMs") {
    super(`${operation === "detail" ? "Detail call" : "Search"} budget exhausted: ${reason}`);
    this.name = "SearchBudgetExceededError";
  }
}

export { SearchBudgetExceededError as SearchBudgetError };

export class SearchProvenanceError extends Error {
  constructor(source: JobSource, resultId: string) {
    super(`resultId ${resultId} was not returned by searchJobs in this run for ${source}`);
    this.name = "SearchProvenanceError";
  }
}

export class SearchNotFinishedError extends Error {
  constructor(message = "The search agent did not call finishSearch before returning.") {
    super(message);
    this.name = "SearchNotFinishedError";
  }
}

function copyCriteria(criteria: Criteria): Criteria {
  return {
    ...criteria,
    roles: [...criteria.roles],
    locations: [...criteria.locations],
    keywords: [...criteria.keywords],
    excludeKeywords: [...criteria.excludeKeywords],
    employmentTypes: [...criteria.employmentTypes],
  };
}

function copyGoal(goal: SearchGoal): SearchGoal {
  if (!goal || typeof goal !== "object" || !goal.criteria || !Array.isArray(goal.enabledSources) || !goal.enabledSources.length) throw new Error("Search goal must include criteria and at least one enabled source.");
  const enabledSources = goal.enabledSources.map((source) => {
    if (typeof source !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(source)) throw new Error(`Invalid enabled source ${String(source)}.`);
    return source;
  });
  if (new Set(enabledSources).size !== enabledSources.length) throw new Error("Search goal sources must be unique.");
  return { criteria: copyCriteria(CriteriaSchema.parse(goal.criteria)), enabledSources };
}

function isoTime(value: number) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function text(value: unknown, limit: number) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function safeError(value: unknown) {
  return text(value instanceof Error ? value.message : value, 320)
    .replace(/(https?:\/\/)([^/\s:@]+)(?::[^/\s@]*)?@/gi, "$1[redacted]@")
    .replace(/(authorization\s*[:=]\s*bearer\s+|bearer\s+)[^\s,}]+/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|apikey|token|secret|password|authorization|access_token)=)[^&\s]*/gi, "$1[redacted]")
    .replace(/([\"']?(?:api[_-]?key|apikey|token|secret|password|authorization|bearer)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,}]+/gi, "$1[redacted]");
}

function copyHit(hit: SearchHit): SearchHit {
  return { ...hit };
}

function copyAttempt(attempt: SearchAttempt): SearchAttempt {
  return { ...attempt };
}

function copyTermination(value: SearchTermination | null): SearchTermination | null {
  return value ? { ...value, unresolvedGoals: [...value.unresolvedGoals] } : null;
}

export class AgentSearchState {
  readonly goal: SearchGoal;
  readonly budget: SearchBudget;
  readonly provenance = new Map<string, string>();
  readonly detailDescriptions = new Map<string, string>();
  private readonly sourceStatsByKey = new Map<JobSource, SearchSourceStats>();
  private readonly attemptList: SearchAttempt[] = [];
  private readonly discoveredHits: SearchHit[] = [];
  private readonly enrichedKeys = new Set<string>();
  private readonly urlKeys = new Map<string, string>();
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  private readonly pending = new Map<number, SearchAttempt>();
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private nextToken = 1;
  private searchCallCount = 0;
  private detailCallCount = 0;
  private discoveredCountValue = 0;
  private uniqueCountValue = 0;
  private terminationValue: SearchTermination | null = null;
  private readonly runId?: string;
  private readonly trajectory?: TrajectoryRecorder;

  constructor(config: { goal: SearchGoal; budget?: Partial<SearchBudget> | SearchBudget } & SearchStateOptions);
  constructor(goal: SearchGoal, budget?: Partial<SearchBudget> | SearchBudget, options?: SearchStateOptions);
  constructor(
    goalOrConfig: SearchGoal | ({ goal: SearchGoal; budget?: Partial<SearchBudget> | SearchBudget } & SearchStateOptions),
    budgetValue: Partial<SearchBudget> | SearchBudget = {},
    options: SearchStateOptions = {},
  ) {
    const config = "goal" in goalOrConfig ? goalOrConfig : { ...options, goal: goalOrConfig, budget: budgetValue };
    this.goal = copyGoal(config.goal);
    this.budget = createSearchBudget(config.budget ?? {});
    this.now = config.now ?? Date.now;
    this.startedAtMs = this.now();
    this.runId = config.runId;
    this.trajectory = config.trajectory;
    for (const source of this.goal.enabledSources) this.sourceStatsByKey.set(source, { searchCalls: 0, detailCalls: 0, discoveredCount: 0, uniqueCount: 0, enrichedCount: 0, errors: 0 });
  }

  get attempts(): SearchAttempt[] { return this.attemptList.map(copyAttempt); }
  get sourceStats(): ReadonlyMap<JobSource, SearchSourceStats> { return this.sourceStatsByKey; }
  get hits(): SearchHit[] { return this.discoveredHits.map(copyHit); }
  get termination(): SearchTermination | null { return copyTermination(this.terminationValue); }
  get isTerminated() { return this.terminationValue !== null; }
  get uniqueCount() { return this.uniqueCountValue; }
  get discoveredCount() { return this.discoveredCountValue; }
  get enrichedCount() { return this.enrichedKeys.size; }
  get uniqueJobs() { return this.uniqueCountValue; }
  get discoveredJobs() { return this.discoveredCountValue; }
  get enrichedJobs() { return this.enrichedKeys.size; }
  get unresolvedGoals() { return this.termination?.unresolvedGoals ?? []; }
  get remaining() { return this.remainingBudgets(); }

  private record(type: string, payload: unknown, kind: TrajectoryEventInput["kind"] = "lifecycle") {
    if (!this.runId || !this.trajectory) return;
    try { this.trajectory(this.runId, { kind, type, payload }); } catch {}
  }

  private source(source: unknown, operation: "search" | "detail"): JobSource {
    if (typeof source === "string" && this.goal.enabledSources.includes(source)) return source;
    const value = typeof source === "string" ? source : "(missing)";
    this.record(`${operation}_source_rejected`, { operation, source: value.slice(0, 100), enabledSources: [...this.goal.enabledSources] }, "error");
    throw new Error(`${operation} source ${value} is not enabled`);
  }

  resolveSource(source: unknown, operation: "search" | "detail" = "search") {
    if (source === undefined || source === null || source === "") {
      if (this.goal.enabledSources.length === 1) return this.goal.enabledSources[0];
      this.record(`${operation}_source_rejected`, { operation, reason: "source_required", enabledSources: [...this.goal.enabledSources] }, "error");
      throw new Error(`${operation} source is required when multiple sources are enabled`);
    }
    return this.source(source, operation);
  }

  remainingBudgets(): SearchBudgetRemaining {
    const elapsed = Math.max(0, this.now() - this.startedAtMs);
    return {
      maxSearchCalls: Math.max(0, this.budget.maxSearchCalls - this.searchCallCount),
      maxDetailCalls: Math.max(0, this.budget.maxDetailCalls - this.detailCallCount),
      maxTotalResults: Math.max(0, this.budget.maxTotalResults - this.discoveredCountValue),
      maxRunDurationMs: Math.max(0, this.budget.maxRunDurationMs - elapsed),
    };
  }

  private open(operation: "search" | "detail", source: JobSource, metadata: Partial<SearchAttempt>) {
    if (!this.terminationValue) return;
    this.attemptList.push({ operation, status: "rejected", source, startedAt: isoTime(this.now()), endedAt: isoTime(this.now()), ...metadata });
    this.record(`${operation}_rejected`, { operation, source, reason: "search_finished" }, "error");
    throw new Error("Search is already finished.");
  }

  private rejectBudget(operation: "search" | "detail", source: JobSource, reason: SearchBudgetExceededError["reason"], metadata: Partial<SearchAttempt>): never {
    const startedAt = isoTime(this.now());
    this.attemptList.push({ operation, status: "rejected", source, startedAt, endedAt: startedAt, ...metadata });
    this.record("search_budget_rejected", {
      operation,
      source,
      reason,
      remaining: this.remainingBudgets(),
      requestedLimit: metadata.requestedLimit,
      resultIdLength: metadata.resultId?.length,
    }, "error");
    throw new SearchBudgetExceededError(operation, reason);
  }

  private rejectProvenance(source: JobSource, resultId: string): never {
    const startedAt = isoTime(this.now());
    this.attemptList.push({ operation: "detail", status: "rejected", source, resultId: text(resultId, 200), startedAt, endedAt: startedAt });
    this.record("detail_provenance_rejected", { source, resultIdLength: resultId.length }, "error");
    throw new SearchProvenanceError(source, resultId);
  }

  private rejectExpired(operation: "search" | "detail", reservation: SearchReservation | DetailReservation): never {
    const attempt = this.pending.get(reservation.token);
    if (attempt) {
      this.pending.delete(reservation.token);
      attempt.status = "rejected";
      attempt.error = "maxRunDurationMs";
      attempt.endedAt = isoTime(this.now());
    }
    this.record("search_budget_rejected", {
      operation,
      source: reservation.source,
      reason: "maxRunDurationMs",
      remaining: this.remainingBudgets(),
      requestedLimit: operation === "search" ? (reservation as SearchReservation).limit : undefined,
      resultIdLength: operation === "detail" ? (reservation as DetailReservation).resultId.length : undefined,
    }, "error");
    throw new SearchBudgetExceededError(operation, "maxRunDurationMs");
  }

  reserveSearch(input: { source?: unknown; query: string; location: string; limit: number }): SearchReservation {
    const source = this.resolveSource(input.source, "search");
    this.open("search", source, { query: text(input.query, 200), location: text(input.location, 120), requestedLimit: input.limit });
    const remaining = this.remainingBudgets();
    const metadata = { query: text(input.query, 200), location: text(input.location, 120), requestedLimit: input.limit };
    if (remaining.maxSearchCalls <= 0) this.rejectBudget("search", source, "maxSearchCalls", metadata);
    if (remaining.maxRunDurationMs <= 0) this.rejectBudget("search", source, "maxRunDurationMs", metadata);
    if (remaining.maxTotalResults <= 0) this.rejectBudget("search", source, "maxTotalResults", metadata);
    const startedAt = isoTime(this.now());
    const attempt: SearchAttempt = { operation: "search", status: "started", source, query: metadata.query, location: metadata.location, requestedLimit: Math.min(input.limit, remaining.maxTotalResults), startedAt };
    const attemptIndex = this.attemptList.push(attempt) - 1;
    const token = this.nextToken++;
    this.pending.set(token, attempt);
    this.searchCallCount += 1;
    const stats = this.sourceStatsByKey.get(source)!;
    stats.searchCalls += 1;
    this.record("search_started", { source, searchCall: this.searchCallCount, requestedLimit: attempt.requestedLimit, remaining: this.remainingBudgets() });
    return { token, source, query: metadata.query, location: metadata.location, limit: attempt.requestedLimit!, attemptIndex };
  }

  completeSearch(reservation: SearchReservation, hits: SearchHit[]) {
    const attempt = this.pending.get(reservation.token);
    if (!attempt || attempt.operation !== "search") throw new Error("Unknown search reservation.");
    if (this.remainingBudgets().maxRunDurationMs <= 0) this.rejectExpired("search", reservation);
    this.pending.delete(reservation.token);
    const added: SearchHit[] = [];
    for (const hit of hits) {
      if (hit.source !== reservation.source) throw new Error("Search result source does not match the enabled source.");
      if (this.discoveredCountValue >= this.budget.maxTotalResults) break;
      this.discoveredCountValue += 1;
      const key = searchProvenanceKey(hit.source, hit.sourceId);
      const normalizedUrl = normalizeUrl(hit.url);
      if (this.provenance.has(key) || this.urlKeys.has(normalizedUrl)) continue;
      this.provenance.set(key, hit.url);
      this.urlKeys.set(normalizedUrl, key);
      this.discoveredHits.push(copyHit(hit));
      added.push(copyHit(hit));
      this.uniqueCountValue += 1;
    }
    const endedAt = isoTime(this.now());
    attempt.status = "completed";
    attempt.resultCount = hits.length;
    attempt.uniqueResultCount = added.length;
    attempt.endedAt = endedAt;
    const stats = this.sourceStatsByKey.get(reservation.source)!;
    stats.discoveredCount += hits.length;
    stats.uniqueCount += added.length;
    this.record("search_completed", { source: reservation.source, resultCount: hits.length, uniqueResultCount: added.length, counts: { unique: this.uniqueCountValue, discovered: this.discoveredCountValue }, remaining: this.remainingBudgets() });
    return added;
  }

  failSearch(reservation: SearchReservation, error: unknown) {
    const attempt = this.pending.get(reservation.token);
    if (!attempt) return;
    this.pending.delete(reservation.token);
    const message = safeError(error) || "Search failed.";
    attempt.status = "failed";
    attempt.error = message;
    attempt.endedAt = isoTime(this.now());
    this.errors.push(`${reservation.source}: ${message}`);
    this.sourceStatsByKey.get(reservation.source)!.errors += 1;
    this.record("search_failed", { source: reservation.source, error: message }, "error");
  }

  private hitFor(source: JobSource, resultId: string) {
    const directKey = searchProvenanceKey(source, resultId);
    if (this.provenance.has(directKey)) return this.discoveredHits.find((hit) => searchProvenanceKey(hit.source, hit.sourceId) === directKey);
    try {
      const key = this.urlKeys.get(normalizeUrl(resultId));
      if (key?.startsWith(`${source}${provenanceSeparator}`)) return this.discoveredHits.find((hit) => searchProvenanceKey(hit.source, hit.sourceId) === key);
    } catch {}
    return undefined;
  }

  reserveDetail(input: { source?: unknown; resultId: string }): DetailReservation {
    const source = this.resolveSource(input.source, "detail");
    const resultId = text(input.resultId, 200);
    const hit = this.hitFor(source, resultId);
    if (!hit) this.rejectProvenance(source, resultId);
    this.open("detail", source, { resultId });
    const remaining = this.remainingBudgets();
    const metadata = { resultId };
    if (remaining.maxDetailCalls <= 0) this.rejectBudget("detail", source, "maxDetailCalls", metadata);
    if (remaining.maxRunDurationMs <= 0) this.rejectBudget("detail", source, "maxRunDurationMs", metadata);
    const startedAt = isoTime(this.now());
    const attempt: SearchAttempt = { operation: "detail", status: "started", source, resultId, startedAt };
    const attemptIndex = this.attemptList.push(attempt) - 1;
    const token = this.nextToken++;
    this.pending.set(token, attempt);
    this.detailCallCount += 1;
    this.sourceStatsByKey.get(source)!.detailCalls += 1;
    this.record("detail_started", { source, sourceId: hit.sourceId, detailCall: this.detailCallCount, remaining: this.remainingBudgets() });
    return { token, source, sourceId: hit.sourceId, resultId, hit: copyHit(hit), cached: false, attemptIndex };
  }

  completeDetail(reservation: DetailReservation, posting: string) {
    const attempt = this.pending.get(reservation.token);
    if (!attempt || attempt.operation !== "detail") throw new Error("Unknown detail reservation.");
    if (this.remainingBudgets().maxRunDurationMs <= 0) this.rejectExpired("detail", reservation);
    this.pending.delete(reservation.token);
    const key = searchProvenanceKey(reservation.source, reservation.sourceId);
    const alreadyEnriched = this.enrichedKeys.has(key);
    this.detailDescriptions.set(key, posting);
    this.enrichedKeys.add(key);
    attempt.status = "completed";
    attempt.endedAt = isoTime(this.now());
    const stats = this.sourceStatsByKey.get(reservation.source)!;
    if (!alreadyEnriched) stats.enrichedCount += 1;
    this.record("detail_completed", { source: reservation.source, sourceId: reservation.sourceId, postingLength: posting.length, enrichedCount: this.enrichedKeys.size, remaining: this.remainingBudgets() });
  }

  failDetail(reservation: DetailReservation, error: unknown) {
    const attempt = this.pending.get(reservation.token);
    if (!attempt) return;
    this.pending.delete(reservation.token);
    const message = safeError(error) || "Detail fetch failed.";
    attempt.status = "failed";
    attempt.error = message;
    attempt.endedAt = isoTime(this.now());
    this.errors.push(`${reservation.source}: ${message}`);
    this.sourceStatsByKey.get(reservation.source)!.errors += 1;
    this.record("detail_failed", { source: reservation.source, sourceId: reservation.sourceId, error: message }, "error");
  }

  getDetail(reservation: Pick<DetailReservation, "source" | "sourceId" | "hit">) {
    const posting = this.detailDescriptions.get(searchProvenanceKey(reservation.source, reservation.sourceId));
    return posting === undefined ? undefined : { ...copyHit(reservation.hit), posting };
  }

  isEnriched(source: JobSource, sourceId: string) {
    return this.enrichedKeys.has(searchProvenanceKey(source, sourceId));
  }

  addWarnings(values: readonly string[]) {
    for (const value of values) if (typeof value === "string" && value.trim() && !this.warnings.includes(value)) this.warnings.push(text(value, 320));
  }

  finish(reason: string, unresolvedGoals: readonly string[] = []) {
    if (this.terminationValue) return this.termination;
    const normalizedReason = text(reason, 500);
    if (!normalizedReason) throw new Error("finishSearch requires a reason.");
    const goals = [...new Set(unresolvedGoals.map((value) => text(value, 240)).filter(Boolean))].slice(0, 20);
    this.terminationValue = { reason: normalizedReason, unresolvedGoals: goals, finishedAt: isoTime(this.now()) };
    this.record("search_finished", { reason: normalizedReason, unresolvedGoals: goals, counts: { unique: this.uniqueCountValue, discovered: this.discoveredCountValue, enriched: this.enrichedCount }, remaining: this.remainingBudgets() });
    return this.termination;
  }

  assertFinished() {
    if (!this.terminationValue) throw new SearchNotFinishedError();
    return this.termination;
  }

  inspect(): AgentSearchSnapshot {
    const snapshot = this.snapshot();
    this.record("search_state_inspected", { counts: snapshot.counts, remaining: snapshot.remaining, sourceStats: snapshot.sourceStats, termination: snapshot.termination ? { reason: snapshot.termination.reason, unresolvedGoalCount: snapshot.termination.unresolvedGoals.length } : null });
    return snapshot;
  }

  snapshot(): AgentSearchSnapshot {
    const remaining = this.remainingBudgets();
    const sourceStats = Object.fromEntries([...this.sourceStatsByKey.entries()].map(([source, stats]) => [source, { ...stats }])) as Record<string, SearchSourceStats>;
    return {
      goal: { criteria: copyCriteria(this.goal.criteria), enabledSources: [...this.goal.enabledSources] },
      attempts: this.attempts,
      sourceStats,
      hits: this.hits,
      uniqueJobs: this.hits,
      enriched: this.discoveredHits.filter((hit) => this.isEnriched(hit.source, hit.sourceId)).map((hit) => ({ source: hit.source, sourceId: hit.sourceId })),
      counts: { unique: this.uniqueCountValue, discovered: this.discoveredCountValue, enriched: this.enrichedKeys.size },
      uniqueCount: this.uniqueCountValue,
      discoveredCount: this.discoveredCountValue,
      enrichedCount: this.enrichedKeys.size,
      remaining,
      remainingSearchCalls: remaining.maxSearchCalls,
      remainingDetailCalls: remaining.maxDetailCalls,
      remainingResultSlots: remaining.maxTotalResults,
      remainingTimeMs: remaining.maxRunDurationMs,
      provenanceCount: this.provenance.size,
      termination: this.termination,
    };
  }
}

export function createAgentSearchState(config: { goal: SearchGoal; budget?: Partial<SearchBudget> | SearchBudget } & SearchStateOptions) {
  return new AgentSearchState(config);
}
