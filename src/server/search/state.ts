import { z } from "zod";
import { normalizeUrl } from "../db.js";
import { CriteriaSchema } from "../config.js";
import type { Criteria, JobSource, SearchBudget, SearchGoal, SearchHit, SearchPageInfo, TrajectoryEventInput, TrajectoryRecorder } from "../../shared.js";

const provenanceSeparator = "\u0000";

export function searchProvenanceKey(source: JobSource, sourceId: string) {
  return `${source}${provenanceSeparator}${sourceId}`;
}

export const SearchBudgetSchema = z.object({
  targetUniqueJobs: z.number().int().min(0).max(500),
  maxSearchCalls: z.number().int().min(0).max(100),
  maxDetailCalls: z.number().int().min(0).max(100),
  maxTotalResults: z.number().int().min(0).max(500),
  minSearchesPerSource: z.number().int().min(0).max(100),
  maxSearchesPerSource: z.number().int().min(1).max(100),
  maxPagesPerQuery: z.number().int().min(1).max(100),
  maxQueryVariantsPerSource: z.number().int().min(1).max(100),
  maxRunDurationMs: z.number().int().min(0).max(3_600_000),
}).strict().superRefine((value, context) => {
  if (value.minSearchesPerSource > value.maxSearchesPerSource) {
    context.addIssue({ code: "custom", path: ["minSearchesPerSource"], message: "minSearchesPerSource cannot exceed maxSearchesPerSource." });
  }
});

export const defaultSearchBudget: SearchBudget = Object.freeze({
  targetUniqueJobs: 50,
  maxSearchCalls: 20,
  maxDetailCalls: 30,
  maxTotalResults: 100,
  minSearchesPerSource: 1,
  maxSearchesPerSource: 12,
  maxPagesPerQuery: 3,
  maxQueryVariantsPerSource: 6,
  maxRunDurationMs: 120_000,
});


type ResolvedSearchBudget = Required<SearchBudget>;

export function createSearchBudget(value: Partial<SearchBudget> = {}): ResolvedSearchBudget {
  return Object.freeze(SearchBudgetSchema.parse({ ...defaultSearchBudget, ...value })) as ResolvedSearchBudget;
}

export function resolveSearchBudget(value: Partial<SearchBudget> | SearchBudget = {}, maxJobs = 50, minimumSearchCalls = 0): ResolvedSearchBudget {
  const boundedMaxJobs = z.number().int().min(0).max(500).parse(maxJobs);
  const boundedMinimumSearchCalls = Math.min(24, Math.max(0, Math.trunc(minimumSearchCalls)));
  const targetUniqueJobs = value.targetUniqueJobs ?? Math.min(50, boundedMaxJobs);
  const maxSearchCalls = value.maxSearchCalls ?? Math.max(20, boundedMinimumSearchCalls);
  const maxDetailCalls = value.maxDetailCalls ?? Math.min(30, Math.max(1, boundedMaxJobs));
  const maxTotalResults = value.maxTotalResults ?? 100;
  return createSearchBudget({
    ...value,
    targetUniqueJobs,
    maxSearchCalls,
    maxDetailCalls,
    maxTotalResults,
  });
}


export type CoverageLevel = "unknown" | "weak" | "medium" | "good";

export type SearchCoverage = Record<string, CoverageLevel>;
export type SearchSourceCoverage = {
  required: JobSource[];
  searched: JobSource[];
  unavailable: JobSource[];
  unsearched: JobSource[];
};


export type SearchMarginalUtility = {
  score: number;
  recentSearches: number;
  recentUniqueJobs: number;
  recentPromisingJobs: number;
  repeatedZeroYieldSearches: number;
  status: "unmeasured" | "high" | "medium" | "low" | "exhausted";
  recommendation: string;
};

export type SearchTerminationReasonCategory =
  | "coverage_sufficient"
  | "marginal_utility_low"
  | "candidates_sufficient"
  | "budget_exhausted"
  | "no_results"
  | "other";

export type SearchAttempt = {
  id: string;
  runId?: string;
  operation: "search" | "detail";
  status: "started" | "completed" | "failed" | "rejected";
  source: JobSource;
  query?: string;
  location?: string;
  page?: number;
  cursor?: string;
  pageInfo?: SearchPageInfo;
  intent?: string;
  resultId?: string;
  requestedLimit?: number;
  resultCount?: number;
  uniqueResultCount?: number;
  duplicateCount?: number;
  promisingResultCount?: number;
  latencyMs?: number;
  repeatCount?: number;
  cached?: boolean;
  error?: string;
  startedAt: string;
  endedAt?: string;
};

export type SearchSourceStats = {
  calls: number;
  searchCalls: number;
  searches: number;
  detailCalls: number;
  discoveredCount: number;
  rawHits: number;
  uniqueCount: number;
  uniqueJobs: number;
  uniqueHits: number;
  duplicateCount: number;
  duplicateRate: number;
  promisingJobs: number;
  promisingHits: number;
  enrichedCount: number;
  errors: number;
  averageYield: number;
  lastYield: number;
  pagesVisited: number[];
  queryHistory: SearchQueryTelemetry[];
};

export type SearchBudgetRemaining = {
  maxSearchCalls: number;
  maxDetailCalls: number;
  maxTotalResults: number;
  maxRunDurationMs: number;
};

export type SearchTermination = {
  reason: string;
  reasonCategory: SearchTerminationReasonCategory;
  unresolvedGoals: string[];
  finishedAt: string;
};

export type SearchRecommendation = {
  source: JobSource;
  query: string;
  location: string;
  limit: number;
  page?: number;
  cursor?: string;
  reason: "source_floor" | "paginate" | "broaden_query" | "exploit_source";
};

export type SearchPlannerStop = "active" | "target_reached" | "budget_exhausted" | "paths_exhausted" | "marginal_yield_saturated";

export type SearchQueryTelemetry = {
  query: string;
  location: string;
  page?: number;
  cursor?: string;
  returnedHits: number;
  uniqueHits: number;
  duplicateRate: number;
  hasMore: boolean;
  nextPage?: number;
  nextCursor?: string;
  total?: number;
};

export type SearchPathTelemetry = {
  path: string;
  source: JobSource;
  query: string;
  location: string;
  page?: number;
  cursor?: string;
  searches: number;
  hasMore: boolean;
  nextPage?: number;
  nextCursor?: string;
  total?: number;
  pagesVisited: number[];
  raw: number;
  unique: number;
  duplicate: number;
  duplicateRate: number;
  averageYield: number;
  lastYield: number;
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
  coverage: SearchCoverage;
  coverageSufficient: boolean;
  sourceCoverage: SearchSourceCoverage;
  marginalUtility: SearchMarginalUtility;
  nextSearch: SearchRecommendation | null;
  plannerStop: SearchPlannerStop;
  queryHistory: string[];
  paths: SearchPathTelemetry[];
};

export type SearchStateOptions = {
  now?: () => number;
  runId?: string;
  trajectory?: TrajectoryRecorder;
  onSearchAttempt?: (attempt: SearchAttempt) => void;
  adaptive?: boolean;
  querySeeds?: ReadonlyMap<JobSource, readonly string[]> | Readonly<Record<string, readonly string[]>>;
  sourceCapabilities?: ReadonlyMap<JobSource, boolean> | Readonly<Record<string, boolean>>;
};

export type SearchReservation = {
  token: number;
  source: JobSource;
  query: string;
  location: string;
  limit: number;
  page?: number;
  cursor?: string;
  intent?: string;
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
export class SearchCoverageError extends Error {
  constructor(public readonly unsearchedSources: JobSource[], public readonly unavailableSources: JobSource[] = []) {
    super(`Search coverage is incomplete; search enabled sources before finishing: ${unsearchedSources.join(", ")}`);
    this.name = "SearchCoverageError";
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

const maxCriterionLength = 240;
// ponytail: cap evidence at 32k for coverage telemetry; hard filters scan full postings.
const maxEvidenceLength = 32_000;
const maxHardCriterionLength = 500;

function normalizedText(value: unknown, limit: number) {
  return String(value ?? "").slice(0, limit).normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
}

function normalizedHardText(value: unknown) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
}

function normalizedHardCriterion(value: unknown) {
  return normalizedHardText(value).slice(0, maxHardCriterionLength);
}

function normalizedEvidence(value: unknown) {
  return normalizedText(value, maxEvidenceLength);
}

function evidence(values: readonly unknown[]) {
  return normalizedEvidence(values.filter(Boolean).join(" "));
}

function includesHardCriterion(value: string, criterion: unknown) {
  const needle = normalizedHardCriterion(criterion);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}+#])${escaped}(?=$|[^\\p{L}\\p{N}+#])`, "u").test(value);
}

function isRemoteLocation(value: unknown) {
  const normalizedLocation = normalizedHardText(value);
  if (!normalizedLocation || /\b(?:no|not|non)\s+remote\b|\bremote\s+(?:not|unavailable|excluded)\b|\b(?:hybrid|on site|onsite|office based|in office)\b/.test(normalizedLocation)) return false;
  return /\b(?:remote|wfh|telecommute|work\s+from\s+home)\b/.test(normalizedLocation);
}

function safeError(value: unknown) {
  return text(value instanceof Error ? value.message : value, 320)
    .replace(/(https?:\/\/)([^/\s:@]+)(?::[^/\s@]*)?@/gi, "$1[redacted]@")
    .replace(/(authorization\s*[:=]\s*bearer\s+|bearer\s+)[^\s,}]+/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|apikey|token|secret|password|authorization|access_token)=)[^&\s]*/gi, "$1[redacted]")
    .replace(/([\"']?(?:api[_-]?key|apikey|token|secret|password|authorization|bearer)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,}]+/gi, "$1[redacted]");
}
function telemetryPageInfo(value: SearchPageInfo | undefined) {
  if (!value) return null;
  return { ...value, ...(value.nextCursor === undefined ? {} : { nextCursor: "[redacted]" }) };
}

function telemetryQuery(value: SearchQueryTelemetry) {
  return {
    ...value,
    ...(value.cursor === undefined ? {} : { cursor: "[redacted]" }),
    ...(value.nextCursor === undefined ? {} : { nextCursor: "[redacted]" }),
  };
}

function telemetryPath(value: SearchPathTelemetry) {
  return {
    ...value,
    ...(value.cursor === undefined ? {} : { path: "[redacted]", cursor: "[redacted]" }),
    ...(value.nextCursor === undefined ? {} : { nextCursor: "[redacted]" }),
  };
}

function telemetryRecommendation(value: SearchRecommendation | null) {
  if (!value) return null;
  return {
    ...value,
    ...(value.cursor === undefined ? {} : { cursor: "[redacted]" }),
  };
}

function telemetrySourceStats(value: SearchSourceStats) {
  return { ...value, queryHistory: value.queryHistory.map(telemetryQuery) };
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
function normalized(value: unknown) {
  return normalizedText(value, maxCriterionLength);
}
function normalizedQuery(value: unknown) {
  return normalized(value).split(" ").filter(Boolean).sort().join(" ");
}
function queryAlternatives(value: string) {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [];
  return [...new Set([
    words.slice(0, -1).join(" "),
    words.slice(1).join(" "),
    ...words,
  ])].filter(candidate => normalizedQuery(candidate) !== normalizedQuery(value));
}
function isReadonlyMap<K, V>(value: unknown): value is ReadonlyMap<K, V> {
  return typeof value === "object" && value !== null && "get" in value && typeof value.get === "function";
}


export function includesCriterion(value: string, criterion: string) {
  const needle = normalized(criterion);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}+#])${escaped}(?=$|[^\\p{L}\\p{N}+#])`, "u").test(normalizedEvidence(value));
}

export function passesHardSearchConstraints(
  hit: Pick<SearchHit, "title" | "company" | "location">,
  criteria: Criteria,
  posting?: string,
) {
  const locationEvidence = hit.location;
  const exclusionEvidence = normalizedHardText([hit.title, hit.company, posting].filter(Boolean).join(" "));
  if (criteria.excludeKeywords.some(keyword => includesHardCriterion(exclusionEvidence, keyword))) return false;
  return !criteria.remoteOnly || isRemoteLocation(locationEvidence);
}

function isDiscoveryCandidate(hit: SearchHit, criteria: Criteria) {
  return passesHardSearchConstraints(hit, criteria);
}

function isPromising(hit: SearchHit, criteria: Criteria, posting?: string) {
  return passesHardSearchConstraints(hit, criteria, posting);
}


function inferReasonCategory(reason: string): SearchTerminationReasonCategory {
  const value = normalized(reason);
  if (/\b(?:budget|quota)\s+(?:(?:is|has been)\s+)?(?:fully\s+)?(?:exhausted|depleted|spent|empty|zero)\b|\b(?:no|zero)\s+(?:budget|quota)(?:\s+(?:remaining|left|remains))?\b|\bno\s+remaining\s+(?:search\s+)?calls?\b|\b(?:search|result|time|run)\s+(?:calls?|slots?|limits?)\s+(?:exhausted|depleted|reached|zero)\b|\b(?:exhausted|depleted)\s+(?:search|result|time|run)\s+(?:calls?|slots?|limits?|budget)\b/.test(value)) return "budget_exhausted";
  if (/(coverage|covered|role|location|keyword).*(sufficient|complete|met)|sufficient coverage/.test(value)) return "coverage_sufficient";
  if (/(marginal|repeat|yield|not useful|no improvement|low utility)/.test(value)) return "marginal_utility_low";
  if (/(candidate|match|enough|sufficient).*(enough|sufficient|found|selected)|enough candidates/.test(value)) return "candidates_sufficient";
  if (/(no result|no relevant|no usable|no source|none found|failed|unavailable)/.test(value)) return "no_results";
  return "other";
}
function coverageLevel(matches: number): CoverageLevel {
  return matches <= 0 ? "weak" : matches === 1 ? "medium" : "good";
}


type SearchPathState = SearchPathTelemetry & { completed: boolean };
export class AgentSearchState {
  readonly goal: SearchGoal;
  readonly budget: ResolvedSearchBudget;
  readonly provenance = new Map<string, string>();
  readonly detailDescriptions = new Map<string, string>();
  private readonly sourceStatsByKey = new Map<JobSource, SearchSourceStats>();
  private readonly attemptList: SearchAttempt[] = [];
  private readonly discoveredHits: SearchHit[] = [];
  private readonly enrichedKeys = new Set<string>();
  private readonly urlKeys = new Map<string, string>();
  private readonly hitAttemptByKey = new Map<string, number>();
  private readonly pathsByKey = new Map<string, SearchPathState>();
  private readonly attemptedPathKeys = new Set<string>();
  private readonly querySeedsBySource = new Map<JobSource, string[]>();
  private readonly sourcePagination = new Map<JobSource, boolean>();
  private readonly autoMutationSources = new Set<JobSource>();
  private readonly adaptive: boolean;
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  private readonly pending = new Map<number, SearchAttempt>();
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private nextToken = 1;
  private nextAttemptId = 1;
  private searchCallCount = 0;
  private detailCallCount = 0;
  private discoveredCountValue = 0;
  private uniqueCountValue = 0;
  private terminationValue: SearchTermination | null = null;
  private readonly runId?: string;
  private readonly trajectory?: TrajectoryRecorder;
  private readonly onSearchAttempt?: (attempt: SearchAttempt) => void;
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
    this.onSearchAttempt = config.onSearchAttempt;
    this.adaptive = config.adaptive === true;
    for (const source of this.goal.enabledSources) {
      this.sourceStatsByKey.set(source, {
        calls: 0,
        searchCalls: 0,
        searches: 0,
        detailCalls: 0,
        discoveredCount: 0,
        rawHits: 0,
        uniqueCount: 0,
        uniqueJobs: 0,
        uniqueHits: 0,
        duplicateCount: 0,
        duplicateRate: 0,
        promisingJobs: 0,
        promisingHits: 0,
        enrichedCount: 0,
        errors: 0,
        averageYield: 0,
        lastYield: 0,
        pagesVisited: [],
        queryHistory: [],
      });
      const querySeedConfig = config.querySeeds;
      const seedValue = isReadonlyMap<JobSource, readonly string[]>(querySeedConfig) ? querySeedConfig.get(source) : querySeedConfig?.[source];
      const roleKeywordSeeds = this.goal.criteria.roles.flatMap(role => this.goal.criteria.keywords.map(keyword => `${role} ${keyword}`));
      const rawSeeds = [...(seedValue ?? []), ...this.goal.criteria.roles, ...this.goal.criteria.keywords, ...roleKeywordSeeds];
      const seeds: string[] = [];
      const seen = new Set<string>();
      for (const value of rawSeeds) {
        if (typeof value !== "string") continue;
        const candidate = text(value, 200);
        const key = normalizedQuery(candidate);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        seeds.push(candidate);
        if (seeds.length >= this.budget.maxQueryVariantsPerSource) break;
      }
      this.querySeedsBySource.set(source, seeds);
      if (seeds.length < 2) this.autoMutationSources.add(source);
      const capabilityConfig = config.sourceCapabilities;
      const pagination = isReadonlyMap<JobSource, boolean>(capabilityConfig) ? capabilityConfig.get(source) : capabilityConfig?.[source];
      this.sourcePagination.set(source, pagination === true);
    }
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
  private attemptPayload(attempt: SearchAttempt, extras: Record<string, unknown> = {}) {
    const resultId = attempt.resultId ? text(attempt.resultId, 200) : null;
    return {
      attemptId: attempt.id,
      operation: attempt.operation,
      status: attempt.status,
      source: text(attempt.source, 80),
      query: attempt.query ? text(attempt.query, 200) : null,
      location: attempt.location ? text(attempt.location, 120) : null,
      intent: attempt.intent ? text(attempt.intent, 200) : null,
      page: attempt.page ?? null,
      cursor: attempt.cursor ? "[redacted]" : null,
      pageInfo: telemetryPageInfo(attempt.pageInfo),
      repeatCount: attempt.repeatCount ?? null,
      requestedLimit: attempt.requestedLimit ?? null,
      resultCount: attempt.resultCount ?? null,
      uniqueResultCount: attempt.uniqueResultCount ?? null,
      duplicateCount: attempt.duplicateCount ?? null,
      promisingResultCount: attempt.promisingResultCount ?? null,
      latencyMs: attempt.latencyMs ?? null,
      sourceId: null,
      resultId,
      resultIdLength: resultId?.length ?? null,
      error: attempt.error ? safeError(attempt.error) : null,
      errorCategory: null,
      remaining: this.remainingBudgets(),
      budget: this.budget,
      ...extras,
    };
  }
  private preAttemptPayload(operation: "search" | "detail", source: string | null, extras: Record<string, unknown> = {}) {
    return {
      attemptId: null,
      operation,
      status: "rejected",
      source: source ? text(source, 80) : null,
      query: null,
      location: null,
      intent: null,
      repeatCount: null,
      requestedLimit: null,
      resultCount: null,
      uniqueResultCount: null,
      duplicateCount: null,
      promisingResultCount: null,
      latencyMs: null,
      sourceId: null,
      resultId: null,
      resultIdLength: null,
      error: null,
      errorCategory: null,
      remaining: this.remainingBudgets(),
      budget: this.budget,
      ...extras,
    };
  }
  private attemptId(operation: "search" | "detail") {
    return `${operation}-${this.nextAttemptId++}`;
  }
  private repeatCount(source: JobSource, query: string, location: string, page?: number, cursor?: string) {
    const path = this.pathKey(source, query, location, page, cursor);
    return this.attemptList.filter(attempt =>
      attempt.operation === "search" &&
      attempt.status !== "rejected" &&
      attempt.source === source &&
      attempt.query !== undefined &&
      this.pathKey(attempt.source, attempt.query, attempt.location ?? "", attempt.page, attempt.cursor) === path
    ).length;
  }
  private pathKey(source: JobSource, query: string, location: string, page?: number, cursor?: string) {
    const canonicalPage = page ?? (cursor === undefined ? 1 : "");
    return [source, normalizedQuery(query), normalized(location), canonicalPage, cursor ?? ""].join("\u0001");
  }
  private initialPath(path: Pick<SearchPathTelemetry, "page" | "cursor">) {
    return path.cursor === undefined && (path.page === undefined || path.page === 1);
  }
  private sameQueryLocation(path: Pick<SearchPathTelemetry, "source" | "query" | "location">, source: JobSource, query: string, location: string) {
    return path.source === source && normalizedQuery(path.query) === normalizedQuery(query) && normalized(path.location) === normalized(location);
  }
  private searchAttempts(source: JobSource) {
    return this.attemptList.filter(attempt => attempt.operation === "search" && attempt.source === source);
  }
  private acceptedSearchAttempts(source: JobSource) {
    return this.searchAttempts(source).filter(attempt => attempt.status !== "rejected");
  }
  private addQueryHistory(source: JobSource, value: SearchQueryTelemetry) {
    const stats = this.sourceStatsByKey.get(source);
    if (!stats) return;
    stats.queryHistory.push({
      query: text(value.query, 200),
      location: text(value.location, 120),
      ...(value.page === undefined ? {} : { page: value.page }),
      ...(value.cursor === undefined ? {} : { cursor: text(value.cursor, 500) }),
      returnedHits: Math.max(0, Math.trunc(value.returnedHits)),
      uniqueHits: Math.max(0, Math.trunc(value.uniqueHits)),
      duplicateRate: Math.max(0, Math.min(1, value.duplicateRate)),
      hasMore: value.hasMore === true,
      ...(value.nextPage === undefined ? {} : { nextPage: value.nextPage }),
      ...(value.nextCursor === undefined ? {} : { nextCursor: text(value.nextCursor, 500) }),
      ...(value.total === undefined ? {} : { total: value.total }),
    });
    if (stats.queryHistory.length > 100) stats.queryHistory.shift();
  }
  private rejectSearchPath(source: JobSource, metadata: Partial<SearchAttempt>, reason: string): never {
    const startedAt = isoTime(this.now());
    const attempt: SearchAttempt = {
      id: this.attemptId("search"),
      runId: this.runId,
      operation: "search",
      status: "rejected",
      source,
      startedAt,
      endedAt: startedAt,
      latencyMs: 0,
      error: reason,
      ...metadata,
    };
    this.attemptList.push(attempt);
    this.onSearchAttempt?.(copyAttempt(attempt));
    this.record("search_path_rejected", this.attemptPayload(attempt, {
      reason,
      error: reason,
      errorCategory: "path",
    }), "error");
    throw new Error(`Search path rejected: ${reason}`);
  }

  private latency(attempt: SearchAttempt) {
    const started = Date.parse(attempt.startedAt);
    return Math.max(0, this.now() - (Number.isNaN(started) ? this.now() : started));
  }
  private source(source: unknown, operation: "search" | "detail"): JobSource {
    if (typeof source === "string" && this.goal.enabledSources.includes(source)) return source;
    const rawValue = typeof source === "string" ? source : "(missing)";
    const value = text(rawValue, 100);
    this.record(`${operation}_source_rejected`, this.preAttemptPayload(operation, value, {
      reason: "source_disabled",
      error: `${operation} source ${value} is not enabled`,
      errorCategory: "disabled_source",
      enabledSources: this.goal.enabledSources.slice(0, 100),
    }), "error");
    throw new Error(`${operation} source ${rawValue} is not enabled`);
  }

  resolveSource(source: unknown, operation: "search" | "detail" = "search") {
    if (source === undefined || source === null || source === "") {
      if (this.goal.enabledSources.length === 1) return this.goal.enabledSources[0];
      const error = `${operation} source is required when multiple sources are enabled`;
      this.record(`${operation}_source_rejected`, this.preAttemptPayload(operation, null, {
        reason: "source_required",
        error,
        errorCategory: "source_required",
        enabledSources: this.goal.enabledSources.slice(0, 100),
      }), "error");
      throw new Error(error);
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
    const startedAt = isoTime(this.now());
    const attempt: SearchAttempt = { id: this.attemptId(operation), operation, status: "rejected", source, startedAt, endedAt: startedAt, latencyMs: 0, ...metadata };
    this.attemptList.push(attempt);
    this.record(`${operation}_rejected`, this.attemptPayload(attempt, {
      reason: "search_finished",
      error: "Search is already finished.",
      errorCategory: "search_finished",
    }), "error");
    throw new Error("Search is already finished.");
  }

  private rejectBudget(operation: "search" | "detail", source: JobSource, reason: SearchBudgetExceededError["reason"], metadata: Partial<SearchAttempt>, extras: Record<string, unknown> = {}): never {
    const startedAt = isoTime(this.now());
    const attempt: SearchAttempt = { id: this.attemptId(operation), runId: this.runId, operation, status: "rejected", source, startedAt, endedAt: startedAt, latencyMs: 0, ...metadata };
    this.attemptList.push(attempt);
    if (operation === "search") this.onSearchAttempt?.(copyAttempt(attempt));
    this.record("search_budget_rejected", this.attemptPayload(attempt, {
      ...extras,
      attemptId: null,
      reason,
      error: `${operation === "detail" ? "Detail" : "Search"} budget exhausted: ${reason}`,
      errorCategory: "budget",
      requestedLimit: metadata.requestedLimit ?? null,
      resultIdLength: metadata.resultId?.length ?? null,
    }), "error");
    throw new SearchBudgetExceededError(operation, reason);
  }

  private rejectProvenance(source: JobSource, resultId: string): never {
    const startedAt = isoTime(this.now());
    this.attemptList.push({ id: this.attemptId("detail"), operation: "detail", status: "rejected", source, resultId: text(resultId, 200), startedAt, endedAt: startedAt, latencyMs: 0 });
    this.record("detail_provenance_rejected", this.preAttemptPayload("detail", source, {
      resultIdLength: resultId.length,
      error: "resultId was not returned by searchJobs in this run.",
      errorCategory: "provenance",
    }), "error");
    throw new SearchProvenanceError(source, resultId);
  }

  private rejectExpired(operation: "search" | "detail", reservation: SearchReservation | DetailReservation): never {
    const attempt = this.pending.get(reservation.token);
    if (attempt) {
      this.pending.delete(reservation.token);
      attempt.status = "rejected";
      attempt.error = "maxRunDurationMs";
      attempt.endedAt = isoTime(this.now());
      attempt.latencyMs = this.latency(attempt);
    }
    this.record("search_budget_rejected", attempt
      ? this.attemptPayload(attempt, {
        reason: "maxRunDurationMs",
        errorCategory: "timeout",
        sourceId: operation === "detail" ? text((reservation as DetailReservation).sourceId, 200) : null,
        requestedLimit: operation === "search" ? (reservation as SearchReservation).limit : null,
        resultIdLength: operation === "detail" ? (reservation as DetailReservation).resultId.length : null,
      })
      : this.preAttemptPayload(operation, reservation.source, {
        reason: "maxRunDurationMs",
        error: "Search duration budget exhausted: maxRunDurationMs",
        errorCategory: "timeout",
        requestedLimit: operation === "search" ? (reservation as SearchReservation).limit : null,
        resultIdLength: operation === "detail" ? (reservation as DetailReservation).resultId.length : null,
      }), "error");
    throw new SearchBudgetExceededError(operation, "maxRunDurationMs");
  }

  reserveSearch(input: { source?: unknown; query: string; location: string; limit: number; page?: number; cursor?: string; intent?: string }): SearchReservation {
    const source = this.resolveSource(input.source, "search");
    const query = z.string().trim().min(1).max(200).parse(input.query);
    const location = z.string().trim().max(120).parse(input.location);
    const limit = z.number().int().min(1).max(25).parse(input.limit);
    const page = input.page === undefined ? undefined : z.number().int().min(1).parse(input.page);
    const cursor = input.cursor === undefined ? undefined : z.string().trim().min(1).max(500).parse(input.cursor);
    const intent = input.intent === undefined ? undefined : z.string().trim().max(200).parse(input.intent) || undefined;
    if (page !== undefined && cursor !== undefined) throw new Error("Search pagination accepts either page or cursor, not both.");
    const repeatCount = this.repeatCount(source, query, location, page, cursor);
    this.open("search", source, { query, location, page, cursor, intent, requestedLimit: limit, repeatCount });
    const remaining = this.remainingBudgets();
    const metadata = { query, location, page, cursor, intent, requestedLimit: limit, repeatCount };
    if (remaining.maxSearchCalls <= 0) this.rejectBudget("search", source, "maxSearchCalls", metadata);
    if (remaining.maxRunDurationMs <= 0) this.rejectBudget("search", source, "maxRunDurationMs", metadata);
    if (remaining.maxTotalResults <= 0) this.rejectBudget("search", source, "maxTotalResults", metadata);
    const canonicalPath = this.pathKey(source, query, location, page, cursor);
    if (this.adaptive) {
      const paginationRequested = (page !== undefined && page > 1) || cursor !== undefined;
      if (paginationRequested && !this.sourcePagination.get(source)) {
        this.rejectSearchPath(source, metadata, "source does not support pagination");
      }
      if (this.attemptedPathKeys.has(canonicalPath)) {
        this.rejectSearchPath(source, metadata, "equivalent source/query/location/page path was already attempted");
      }
      const accepted = this.acceptedSearchAttempts(source);
      if (accepted.length >= this.budget.maxSearchesPerSource) {
        this.rejectSearchPath(source, metadata, "maxSearchesPerSource");
      }
      const variants = new Set(accepted.filter(attempt => this.initialPath(attempt)).map(attempt => normalizedQuery(attempt.query)));
      const initialRequest = this.initialPath({ page, cursor });
      if (initialRequest && !variants.has(normalizedQuery(query)) && variants.size >= this.budget.maxQueryVariantsPerSource) {
        this.rejectSearchPath(source, metadata, "maxQueryVariantsPerSource");
      }
      const samePath = accepted.filter(attempt => normalizedQuery(attempt.query) === normalizedQuery(query) && normalized(attempt.location) === normalized(location));
      if (samePath.length >= this.budget.maxPagesPerQuery) {
        this.rejectSearchPath(source, metadata, "maxPagesPerQuery");
      }
      if (page !== undefined && page > 1) {
        const prior = [...this.pathsByKey.values()].find(path =>
          this.sameQueryLocation(path, source, query, location) &&
          path.completed &&
          path.hasMore &&
          (path.nextPage === page || (path.nextPage === undefined && path.page !== undefined && path.page + 1 === page)));
        if (!prior) this.rejectSearchPath(source, metadata, "page is not the next available page");
      }
      if (cursor !== undefined) {
        const prior = [...this.pathsByKey.values()].find(path =>
          this.sameQueryLocation(path, source, query, location) &&
          path.completed &&
          path.hasMore &&
          path.nextCursor === cursor);
        if (!prior) this.rejectSearchPath(source, metadata, "cursor is not the next available cursor");
      }
      this.attemptedPathKeys.add(canonicalPath);
    }
    const startedAt = isoTime(this.now());
    const attempt: SearchAttempt = { id: this.attemptId("search"), runId: this.runId, operation: "search", status: "started", source, query, location, page, cursor, intent, requestedLimit: Math.min(limit, remaining.maxTotalResults), repeatCount, startedAt };
    const attemptIndex = this.attemptList.push(attempt) - 1;
    const token = this.nextToken++;
    this.pending.set(token, attempt);
    this.searchCallCount += 1;
    const stats = this.sourceStatsByKey.get(source)!;
    stats.calls += 1;
    stats.searchCalls += 1;
    stats.searches += 1;
    stats.lastYield = 0;
    stats.averageYield = stats.uniqueHits / Math.max(1, stats.searches);
    this.record("search_started", this.attemptPayload(attempt, { searchCall: this.searchCallCount }), "lifecycle");
    return { token, source, query, location, page, cursor, limit: attempt.requestedLimit!, intent, attemptIndex };
  }

  completeSearch(reservation: SearchReservation, hits: SearchHit[], responsePageInfo?: SearchPageInfo) {
    const attempt = this.pending.get(reservation.token);
    if (!attempt || attempt.operation !== "search") throw new Error("Unknown search reservation.");
    if (this.remainingBudgets().maxRunDurationMs <= 0) this.rejectExpired("search", reservation);
    this.pending.delete(reservation.token);
    const consumedHits = hits.slice(0, Math.max(0, this.budget.maxTotalResults - this.discoveredCountValue));
    const added: SearchHit[] = [];
    let duplicateCount = 0;
    let promisingResultCount = 0;
    for (const hit of consumedHits) {
      if (hit.source !== reservation.source) throw new Error("Search result source does not match the enabled source.");
      this.discoveredCountValue += 1;
      const key = searchProvenanceKey(hit.source, hit.sourceId);
      const normalizedUrl = normalizeUrl(hit.url);
      if (this.provenance.has(key) || this.urlKeys.has(normalizedUrl)) {
        duplicateCount += 1;
        continue;
      }
      this.provenance.set(key, hit.url);
      this.urlKeys.set(normalizedUrl, key);
      this.hitAttemptByKey.set(key, reservation.attemptIndex);
      this.discoveredHits.push(copyHit(hit));
      added.push(copyHit(hit));
      this.uniqueCountValue += 1;
      if (isPromising(hit, this.goal.criteria)) promisingResultCount += 1;
    }
    const endedAt = isoTime(this.now());
    attempt.status = "completed";
    attempt.pageInfo = responsePageInfo;
    attempt.resultCount = consumedHits.length;
    attempt.uniqueResultCount = added.length;
    attempt.duplicateCount = duplicateCount;
    attempt.promisingResultCount = promisingResultCount;
    attempt.latencyMs = this.latency(attempt);
    attempt.endedAt = endedAt;
    const currentPage = reservation.page ?? responsePageInfo?.page ?? (this.adaptive && reservation.cursor === undefined ? 1 : undefined);
    if (this.adaptive && attempt.page === undefined && attempt.cursor === undefined && currentPage !== undefined) attempt.page = currentPage;
    const path = this.pathKey(reservation.source, reservation.query, reservation.location, reservation.page, reservation.cursor);
    const prior = this.pathsByKey.get(path);
    const pagesVisited = [...(prior?.pagesVisited ?? [])];
    if (currentPage !== undefined && !pagesVisited.includes(currentPage)) pagesVisited.push(currentPage);
    const searches = (prior?.searches ?? 0) + 1;
    const raw = (prior?.raw ?? 0) + consumedHits.length;
    const unique = (prior?.unique ?? 0) + added.length;
    this.pathsByKey.set(path, {
      path,
      source: reservation.source,
      query: reservation.query,
      location: reservation.location,
      ...(currentPage === undefined ? {} : { page: currentPage }),
      ...(reservation.cursor === undefined ? {} : { cursor: reservation.cursor }),
      searches,
      completed: true,
      hasMore: responsePageInfo?.hasMore === true,
      ...(responsePageInfo?.nextPage === undefined ? {} : { nextPage: responsePageInfo.nextPage }),
      ...(responsePageInfo?.nextCursor === undefined ? {} : { nextCursor: responsePageInfo.nextCursor }),
      ...(responsePageInfo?.total === undefined ? {} : { total: responsePageInfo.total }),
      pagesVisited,
      raw,
      unique,
      duplicate: (prior?.duplicate ?? 0) + duplicateCount,
      duplicateRate: raw ? ((prior?.duplicate ?? 0) + duplicateCount) / raw : 0,
      averageYield: ((prior?.averageYield ?? 0) * (searches - 1) + added.length) / searches,
      lastYield: added.length,
    });
    const stats = this.sourceStatsByKey.get(reservation.source)!;
    stats.discoveredCount += consumedHits.length;
    stats.rawHits += consumedHits.length;
    stats.uniqueCount += added.length;
    stats.uniqueJobs += added.length;
    stats.uniqueHits += added.length;
    stats.duplicateCount += duplicateCount;
    stats.promisingJobs += promisingResultCount;
    stats.promisingHits += promisingResultCount;
    stats.duplicateRate = stats.rawHits ? stats.duplicateCount / stats.rawHits : 0;
    stats.lastYield = added.length;
    stats.averageYield = stats.uniqueHits / Math.max(1, stats.searches);
    if (currentPage !== undefined && !stats.pagesVisited.includes(currentPage)) stats.pagesVisited.push(currentPage);
    this.addQueryHistory(reservation.source, {
      query: reservation.query,
      location: reservation.location,
      ...(currentPage === undefined ? {} : { page: currentPage }),
      ...(reservation.cursor === undefined ? {} : { cursor: reservation.cursor }),
      returnedHits: consumedHits.length,
      uniqueHits: added.length,
      duplicateRate: consumedHits.length ? duplicateCount / consumedHits.length : 0,
      hasMore: responsePageInfo?.hasMore === true,
      ...(responsePageInfo?.nextPage === undefined ? {} : { nextPage: responsePageInfo.nextPage }),
      ...(responsePageInfo?.nextCursor === undefined ? {} : { nextCursor: responsePageInfo.nextCursor }),
      ...(responsePageInfo?.total === undefined ? {} : { total: responsePageInfo.total }),
    });
    this.onSearchAttempt?.(copyAttempt(attempt));
    this.record("search_completed", this.attemptPayload(attempt, {
      counts: { unique: this.uniqueCountValue, discovered: this.discoveredCountValue, enriched: this.enrichedKeys.size },
    }));
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
    attempt.latencyMs = this.latency(attempt);
    this.errors.push(`${reservation.source}: ${message}`);
    const stats = this.sourceStatsByKey.get(reservation.source)!;
    stats.errors += 1;
    stats.lastYield = 0;
    stats.averageYield = stats.uniqueHits / Math.max(1, stats.searches);
    this.addQueryHistory(reservation.source, {
      query: reservation.query,
      location: reservation.location,
      ...(reservation.page === undefined ? {} : { page: reservation.page }),
      ...(reservation.cursor === undefined ? {} : { cursor: reservation.cursor }),
      returnedHits: 0,
      uniqueHits: 0,
      duplicateRate: 0,
      hasMore: false,
    });
    this.record("search_failed", this.attemptPayload(attempt, { errorCategory: "provider" }), "error");
    this.onSearchAttempt?.(copyAttempt(attempt));
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
    const sourceId = text(hit.sourceId, 200);
    this.open("detail", source, { resultId });
    const remaining = this.remainingBudgets();
    const metadata = { resultId };
    const eventExtras = { sourceId, resultIdLength: resultId.length };
    if (remaining.maxDetailCalls <= 0) this.rejectBudget("detail", source, "maxDetailCalls", metadata, eventExtras);
    if (remaining.maxRunDurationMs <= 0) this.rejectBudget("detail", source, "maxRunDurationMs", metadata, eventExtras);
    const startedAt = isoTime(this.now());
    const attempt: SearchAttempt = { id: this.attemptId("detail"), operation: "detail", status: "started", source, resultId, cached: false, startedAt };
    const attemptIndex = this.attemptList.push(attempt) - 1;
    const token = this.nextToken++;
    this.pending.set(token, attempt);
    this.detailCallCount += 1;
    const stats = this.sourceStatsByKey.get(source)!;
    stats.detailCalls += 1;
    this.record("detail_started", this.attemptPayload(attempt, { sourceId, detailCall: this.detailCallCount, cached: false }), "lifecycle");
    return { token, source, sourceId: hit.sourceId, resultId, hit: copyHit(hit), cached: false, attemptIndex };
  }

  completeDetail(reservation: DetailReservation, posting: string) {
    const attempt = this.pending.get(reservation.token);
    if (!attempt || attempt.operation !== "detail") throw new Error("Unknown detail reservation.");
    if (this.remainingBudgets().maxRunDurationMs <= 0) this.rejectExpired("detail", reservation);
    this.pending.delete(reservation.token);
    const key = searchProvenanceKey(reservation.source, reservation.sourceId);
    const previousPosting = this.detailDescriptions.get(key);
    const wasPromising = isPromising(reservation.hit, this.goal.criteria, previousPosting);
    const alreadyEnriched = this.enrichedKeys.has(key);
    this.detailDescriptions.set(key, posting);
    this.enrichedKeys.add(key);
    const isNowPromising = isPromising(reservation.hit, this.goal.criteria, posting);
    if (wasPromising !== isNowPromising) {
      const delta = isNowPromising ? 1 : -1;
      const searchAttempt = this.attemptList[this.hitAttemptByKey.get(key) ?? -1];
      if (searchAttempt?.operation === "search") searchAttempt.promisingResultCount = (searchAttempt.promisingResultCount ?? 0) + delta;
      const sourceStats = this.sourceStatsByKey.get(reservation.source)!;
      sourceStats.promisingJobs += delta;
      sourceStats.promisingHits += delta;
    }
    attempt.status = "completed";
    attempt.endedAt = isoTime(this.now());
    attempt.latencyMs = this.latency(attempt);
    const stats = this.sourceStatsByKey.get(reservation.source)!;
    if (!alreadyEnriched) stats.enrichedCount += 1;
    this.record("detail_completed", this.attemptPayload(attempt, {
      sourceId: text(reservation.sourceId, 200),
      postingLength: posting.length,
      enrichedCount: this.enrichedKeys.size,
      promising: isNowPromising,
    }));
  }

  failDetail(reservation: DetailReservation, error: unknown) {
    const attempt = this.pending.get(reservation.token);
    if (!attempt) return;
    this.pending.delete(reservation.token);
    const message = safeError(error) || "Detail fetch failed.";
    attempt.status = "failed";
    attempt.error = message;
    attempt.endedAt = isoTime(this.now());
    attempt.latencyMs = this.latency(attempt);
    this.errors.push(`${reservation.source}: ${message}`);
    this.sourceStatsByKey.get(reservation.source)!.errors += 1;
    this.record("detail_failed", this.attemptPayload(attempt, {
      sourceId: text(reservation.sourceId, 200),
      errorCategory: "provider",
    }), "error");
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

  private sourceCoverage(): SearchSourceCoverage {
    const completed = new Set<JobSource>();
    const unavailable = new Set<JobSource>();
    for (const attempt of this.attemptList) {
      if (attempt.operation !== "search") continue;
      if (attempt.status === "completed") {
        completed.add(attempt.source);
        unavailable.delete(attempt.source);
      } else if (attempt.status === "failed" && !completed.has(attempt.source)) {
        unavailable.add(attempt.source);
      }
    }
    const required = [...this.goal.enabledSources];
    const searched = required.filter(source => completed.has(source) || unavailable.has(source));
    const unavailableSources = required.filter(source => unavailable.has(source) && !completed.has(source));
    const unsearched = required.filter(source => !completed.has(source) && !unavailable.has(source));
    return { required, searched, unavailable: unavailableSources, unsearched };
  }

  private coverageDetails() {
    const criteria = this.goal.criteria;
    const hits = this.discoveredHits;
    const coverage: SearchCoverage = {};
    const dimensions: Array<[string, string, "role" | "location" | "keyword"]> = [
      ...criteria.roles.map(role => [`role:${normalized(role)}`, role, "role"] as [string, string, "role"]),
      ...criteria.locations.map(location => [`location:${normalized(location)}`, location, "location"] as [string, string, "location"]),
      ...criteria.keywords.map(keyword => [`keyword:${normalized(keyword)}`, keyword, "keyword"] as [string, string, "keyword"]),
    ];
    let allMatched = true;
    const candidates = hits.filter(hit => isDiscoveryCandidate(hit, criteria));
    const inspectedCandidateCount = candidates.filter(hit => this.detailDescriptions.has(searchProvenanceKey(hit.source, hit.sourceId))).length;
    for (const [key, criterion, kind] of dimensions) {
      const matches = candidates.filter(hit => {
        const posting = this.detailDescriptions.get(searchProvenanceKey(hit.source, hit.sourceId));
        if (kind === "keyword" && posting === undefined) return false;
        const value = kind === "role"
          ? normalizedEvidence(hit.title)
          : kind === "location"
            ? normalizedEvidence(hit.location)
            : evidence([hit.title, posting]);
        return includesCriterion(value, criterion);
      }).length;
      if (kind === "keyword" && (candidates.length === 0 || inspectedCandidateCount < candidates.length)) {
        coverage[key] = "unknown";
        allMatched = false;
        continue;
      }
      coverage[key] = coverageLevel(matches);
      if (coverage[key] === "weak") allMatched = false;
    }
    const promisingJobs = hits.filter(hit => isPromising(hit, criteria, this.detailDescriptions.get(searchProvenanceKey(hit.source, hit.sourceId)))).length;
    coverage.overall = coverageLevel(promisingJobs);
    return { coverage, coverageSufficient: allMatched && promisingJobs > 0 };
  }
  private sourceCoverageGap(source: JobSource) {
    const criteria = this.goal.criteria;
    const candidates = this.discoveredHits.filter(hit => hit.source === source && isDiscoveryCandidate(hit, criteria));
    const dimensions: Array<[string, "role" | "location" | "keyword"]> = [
      ...criteria.roles.map(value => [value, "role"] as [string, "role"]),
      ...criteria.locations.map(value => [value, "location"] as [string, "location"]),
      ...criteria.keywords.map(value => [value, "keyword"] as [string, "keyword"]),
    ];
    if (!dimensions.length) return 0;
    const matched = dimensions.filter(([criterion, kind]) => candidates.some(hit => {
      const posting = this.detailDescriptions.get(searchProvenanceKey(hit.source, hit.sourceId));
      if (kind === "keyword" && posting === undefined) return false;
      const value = kind === "role"
        ? normalizedEvidence(hit.title)
        : kind === "location"
          ? normalizedEvidence(hit.location)
          : evidence([hit.title, posting]);
      return includesCriterion(value, criterion);
    })).length;
    return (dimensions.length - matched) / dimensions.length;
  }
  private plannerDecision(): { nextSearch: SearchRecommendation | null; plannerStop: SearchPlannerStop } {
    if (!this.adaptive) return { nextSearch: null, plannerStop: "active" };
    const remaining = this.remainingBudgets();
    if (remaining.maxSearchCalls <= 0 || remaining.maxTotalResults <= 0 || remaining.maxRunDurationMs <= 0) {
      return { nextSearch: null, plannerStop: "budget_exhausted" };
    }
    const observedLocation = this.attemptList.find(attempt => attempt.operation === "search" && attempt.status !== "rejected" && attempt.location?.trim())?.location;
    const location = this.goal.criteria.locations[0] ?? observedLocation ?? "";
    const seeds = (source: JobSource) => this.querySeedsBySource.get(source) ?? [];
    const accepted = (source: JobSource) => this.acceptedSearchAttempts(source);
    const completed = (source: JobSource) => accepted(source).filter(attempt => attempt.status === "completed").length;
    const failed = (source: JobSource) => accepted(source).some(attempt => attempt.status === "failed") && completed(source) === 0;
    const usedQuery = (source: JobSource, query: string) => accepted(source).some(attempt =>
      normalizedQuery(attempt.query) === normalizedQuery(query) &&
      normalized(attempt.location) === normalized(location) &&
      (attempt.page === undefined || attempt.page === 1) &&
      attempt.cursor === undefined);
    const variantsFor = (source: JobSource) => new Set(accepted(source)
      .filter(attempt => this.initialPath(attempt))
      .map(attempt => normalizedQuery(attempt.query)));
    const pagesVisitedFor = (path: SearchPathState) => accepted(path.source).filter(attempt =>
      normalizedQuery(attempt.query) === normalizedQuery(path.query) &&
      normalized(attempt.location) === normalized(path.location)).length;
    const queryFor = (source: JobSource) => {
      if (variantsFor(source).size >= this.budget.maxQueryVariantsPerSource) return undefined;
      const candidates = [...seeds(source)];
      if (this.autoMutationSources.has(source)) {
        for (const attempt of accepted(source).filter(candidate => this.initialPath(candidate))) {
          candidates.push(...queryAlternatives(attempt.query ?? ""));
        }
      }
      return candidates.find(candidate => !usedQuery(source, candidate));
    };
    const recommendation = (source: JobSource, query: string, reason: SearchRecommendation["reason"], page?: number, cursor?: string): SearchRecommendation => ({
      source,
      query,
      location,
      limit: Math.min(25, Math.max(1, remaining.maxTotalResults)),
      ...(page === undefined ? {} : { page }),
      ...(cursor === undefined ? {} : { cursor }),
      reason,
    });
    for (const source of this.goal.enabledSources) {
      if (failed(source) || accepted(source).length >= this.budget.maxSearchesPerSource) continue;
      if (completed(source) < this.budget.minSearchesPerSource) {
        const query = queryFor(source);
        if (query) return { nextSearch: recommendation(source, query, "source_floor"), plannerStop: "active" };
      }
    }
    if (this.uniqueCountValue >= this.budget.targetUniqueJobs) return { nextSearch: null, plannerStop: "target_reached" };
    const paginationCandidates = [...this.pathsByKey.values()]
      .map((path, index) => {
        const stats = this.sourceStatsByKey.get(path.source);
        const score = path.lastYield * 2 + path.averageYield + (stats?.promisingHits ?? 0) / Math.max(1, stats?.searches ?? 1) - path.duplicateRate * 2 + this.sourceCoverageGap(path.source) * 0.5;
        return { path, index, score };
      })
      .filter(({ path }) => path.completed && path.hasMore && path.lastYield > 0 && this.sourcePagination.get(path.source) === true)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    for (const { path } of paginationCandidates) {
      if (pagesVisitedFor(path) >= this.budget.maxPagesPerQuery || accepted(path.source).length >= this.budget.maxSearchesPerSource) continue;
      const nextCursor = path.nextCursor;
      const nextPage = nextCursor === undefined ? path.nextPage ?? (path.page === undefined ? undefined : path.page + 1) : undefined;
      if (nextPage === undefined && nextCursor === undefined) continue;
      const key = this.pathKey(path.source, path.query, path.location, nextPage, nextCursor);
      if (this.attemptedPathKeys.has(key) || this.pathsByKey.has(key)) continue;
      return { nextSearch: recommendation(path.source, path.query, "paginate", nextPage, nextCursor), plannerStop: "active" };
    }
    const queryCandidates = this.goal.enabledSources
      .map((source, index) => {
        const stats = this.sourceStatsByKey.get(source)!;
        const score = stats.lastYield * 2 + stats.averageYield + stats.promisingHits / Math.max(1, stats.searches) - stats.duplicateRate * 2 + this.sourceCoverageGap(source) * 0.5;
        return { source, index, score };
      })
      .filter(({ source }) => !failed(source) && accepted(source).length < this.budget.maxSearchesPerSource)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    for (const { source } of queryCandidates) {
      const query = queryFor(source);
      if (!query) continue;
      const reason: SearchRecommendation["reason"] = completed(source) === 0 ? "source_floor" : this.sourceStatsByKey.get(source)!.lastYield > 0 ? "exploit_source" : "broaden_query";
      return { nextSearch: recommendation(source, query, reason), plannerStop: "active" };
    }
    const completedSearches = this.attemptList.filter(attempt => attempt.operation === "search" && attempt.status === "completed");
    const recent = completedSearches.slice(-4);
    const recentUnique = recent.reduce((sum, attempt) => sum + (attempt.uniqueResultCount ?? 0), 0);
    if (recent.length >= 4 && recentUnique <= 2) return { nextSearch: null, plannerStop: "marginal_yield_saturated" };
    return { nextSearch: null, plannerStop: "paths_exhausted" };
  }

  private pathSnapshot() {
    return [...this.pathsByKey.values()].map(path => ({ ...path, pagesVisited: [...path.pagesVisited] }));
  }

  private marginalUtility(): SearchMarginalUtility {
    const recent = this.attemptList.filter(attempt => attempt.operation === "search" && attempt.status === "completed").slice(-5);
    if (!recent.length) return { score: 0, recentSearches: 0, recentUniqueJobs: 0, recentPromisingJobs: 0, repeatedZeroYieldSearches: 0, status: "unmeasured", recommendation: "Run a search before judging marginal utility." };
    const recentUniqueJobs = recent.reduce((sum, attempt) => sum + (attempt.uniqueResultCount ?? 0), 0);
    const recentPromisingJobs = recent.reduce((sum, attempt) => sum + (attempt.promisingResultCount ?? 0), 0);
    const repeatedZeroYieldSearches = recent.filter(attempt => (attempt.uniqueResultCount ?? 0) === 0 && (attempt.repeatCount ?? 0) > 0).length;
    const score = recentPromisingJobs / recent.length;
    const status = this.remainingBudgets().maxSearchCalls <= 0 ? "exhausted" : score >= 2 && recentPromisingJobs > 0 ? "high" : score >= 1 ? "medium" : "low";
    const recommendation = status === "exhausted"
      ? "Search budget is exhausted; finish with the evidence collected."
      : repeatedZeroYieldSearches >= 2
        ? "Avoid repeating the same ineffective source, query, and location; vary the query or switch source."
        : status === "low"
          ? "Yield is weak; vary role phrasing, keywords, or location before another search."
          : "Continue only when another search is likely to add distinct promising jobs.";
    return { score, recentSearches: recent.length, recentUniqueJobs, recentPromisingJobs, repeatedZeroYieldSearches, status, recommendation };
  }

  finish(reason: string, unresolvedGoals: readonly string[] = [], reasonCategory?: SearchTerminationReasonCategory) {
    if (this.terminationValue) return this.termination;
    const normalizedReason = text(reason, 500);
    if (!normalizedReason) throw new Error("finishSearch requires a reason.");
    const goals = [...new Set(unresolvedGoals.map((value) => text(value, 240)).filter(Boolean))].slice(0, 20);
    const sourceCoverage = this.sourceCoverage();
    const remaining = this.remainingBudgets();
    const coverageBudgetExhausted = remaining.maxSearchCalls <= 0 || remaining.maxTotalResults <= 0 || remaining.maxRunDurationMs <= 0;
    const anyBudgetExhausted = coverageBudgetExhausted || remaining.maxDetailCalls <= 0;
    const terminationReasonCategory = reasonCategory ?? inferReasonCategory(normalizedReason);
    const decision = this.plannerDecision();
    const coverageState = this.coverageDetails();
    if (this.adaptive && decision.nextSearch) {
      const error = new Error("Adaptive search still has viable work.");
      this.record("search_finish_rejected", { reason: normalizedReason, reasonCategory: terminationReasonCategory, nextSearch: telemetryRecommendation(decision.nextSearch), plannerStop: decision.plannerStop, error: error.message }, "error");
      throw error;
    }
    if (terminationReasonCategory === "budget_exhausted" && !anyBudgetExhausted) {
      const error = new Error("budget_exhausted is valid only when a search, detail, result, or time budget is exhausted.");
      this.record("search_finish_rejected", { reason: normalizedReason, reasonCategory: terminationReasonCategory, remaining, error: error.message, errorCategory: "budget" }, "error");
      throw error;
    }
    if (sourceCoverage.unsearched.length && !coverageBudgetExhausted) {
      const error = new SearchCoverageError(sourceCoverage.unsearched, sourceCoverage.unavailable);
      this.record("search_finish_rejected", { reason: normalizedReason, unsearchedSources: sourceCoverage.unsearched, unavailableSources: sourceCoverage.unavailable, remaining, error: error.message, errorCategory: "coverage" }, "error");
      throw error;
    }
    this.terminationValue = { reason: normalizedReason, reasonCategory: terminationReasonCategory, unresolvedGoals: goals, finishedAt: isoTime(this.now()) };
    const { coverage, coverageSufficient } = coverageState;
    const marginalUtility = this.marginalUtility();
    const sourceStats = Object.fromEntries([...this.sourceStatsByKey.entries()].map(([source, stats]) => [source, telemetrySourceStats(stats)]));
    this.record("search_finished", {
      attemptId: null, operation: null, status: null, source: null, query: null, location: null, intent: null, repeatCount: null,
      requestedLimit: null, resultCount: null, uniqueResultCount: null, duplicateCount: null, promisingResultCount: null, latencyMs: null,
      sourceId: null, resultId: null, resultIdLength: null, error: null, errorCategory: null, reason: normalizedReason,
      reasonCategory: this.terminationValue.reasonCategory, unresolvedGoals: goals, termination: { ...this.terminationValue, unresolvedGoals: [...goals] },
      counts: { unique: this.uniqueCountValue, discovered: this.discoveredCountValue, enriched: this.enrichedKeys.size }, coverage, coverageSufficient,
      sourceCoverage, marginalUtility, sourceStats, remaining, budget: this.budget, nextSearch: telemetryRecommendation(decision.nextSearch), plannerStop: decision.plannerStop,
    });
    return this.termination;
  }


  assertFinished() {
    if (!this.terminationValue) throw new SearchNotFinishedError();
    return this.termination;
  }

  inspect(): AgentSearchSnapshot {
    const snapshot = this.snapshot();
    this.record("search_state_inspected", {
      attemptId: null,
      operation: null,
      status: null,
      source: null,
      query: null,
      location: null,
      intent: null,
      repeatCount: null,
      requestedLimit: null,
      resultCount: null,
      uniqueResultCount: null,
      duplicateCount: null,
      promisingResultCount: null,
      latencyMs: null,
      sourceId: null,
      resultId: null,
      resultIdLength: null,
      error: null,
      errorCategory: null,
      counts: snapshot.counts,
      remaining: snapshot.remaining,
      budget: this.budget,
      sourceStats: Object.fromEntries(Object.entries(snapshot.sourceStats).map(([source, stats]) => [source, telemetrySourceStats(stats)])),
      sourceCoverage: snapshot.sourceCoverage,
      coverage: snapshot.coverage,
      marginalUtility: snapshot.marginalUtility,
      coverageSufficient: snapshot.coverageSufficient,
      nextSearch: telemetryRecommendation(snapshot.nextSearch),
      plannerStop: snapshot.plannerStop,
      queryHistory: snapshot.queryHistory,
      paths: snapshot.paths.map(telemetryPath),
      termination: snapshot.termination ? {
        ...snapshot.termination,
        unresolvedGoals: [...snapshot.termination.unresolvedGoals],
        unresolvedGoalCount: snapshot.termination.unresolvedGoals.length,
      } : null,
    });
    return snapshot;
  }
  snapshot(): AgentSearchSnapshot {
    const remaining = this.remainingBudgets();
    const sourceStats = Object.fromEntries([...this.sourceStatsByKey.entries()].map(([source, stats]) => [source, { ...stats }])) as Record<string, SearchSourceStats>;
    const sourceCoverage = this.sourceCoverage();
    const { coverage, coverageSufficient } = this.coverageDetails();
    const planner = this.plannerDecision();
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
      coverage,
      coverageSufficient,
      sourceCoverage,
      marginalUtility: this.marginalUtility(),
      nextSearch: planner.nextSearch,
      plannerStop: planner.plannerStop,
      queryHistory: this.attemptList.filter(attempt => attempt.operation === "search" && attempt.query).map(attempt => attempt.query!),
      paths: this.pathSnapshot(),
    };
  }
}

export function createAgentSearchState(config: { goal: SearchGoal; budget?: Partial<SearchBudget> | SearchBudget } & SearchStateOptions) {
  return new AgentSearchState(config);
}
