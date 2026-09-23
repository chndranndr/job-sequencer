import { isJsonRecord, type Run, type RunTrajectoryAdaptation, type RunTrajectoryAttempt, type RunTrajectoryAttemptStatus, type RunTrajectoryBudget, type RunTrajectoryCounts, type RunTrajectoryFunnel, type RunTrajectoryNextSearch, type RunTrajectoryObservability, type RunTrajectoryPath, type RunTrajectoryPolicyEvent, type RunTrajectoryQueryRecord, type RunTrajectoryResources, type RunTrajectorySourceCoverage, type RunTrajectorySourceStats, type RunTrajectoryStateSnapshot, type RunTrajectoryTermination, type TrajectoryEvent } from "./shared.js";

type Payload = Record<string, unknown>;
type AttemptOperation = RunTrajectoryAttempt["operation"];
type AttemptIndex = number;

type SourceAccumulator = {
  searchCalls: number | null;
  detailCalls: number | null;
  rawHits: number | null;
  uniqueCount: number | null;
  duplicateCount: number | null;
  duplicateRate: number | null;
  promisingCount: number | null;
  enrichedCount: number | null;
  failures: number | null;
  latencyTotal: number;
  latencySamples: number;
  searches: number | null;
  uniqueHits: number | null;
  promisingHits: number | null;
  averageYield: number | null;
  lastYield: number | null;
  pagesVisited: number[] | null;
  queryHistory: RunTrajectoryQueryRecord[] | null;
};

const MAX_ATTEMPTS = 500;
const MAX_STATES = 250;
const MAX_ADAPTATIONS = 250;
const MAX_POLICY_EVENTS = 250;
const MAX_SOURCES = 100;
const MAX_SOURCE_LENGTH = 80;
const MAX_ID_LENGTH = 200;
const MAX_CURSOR_LENGTH = 500;
const MAX_QUERY_HISTORY = 250;
const MAX_PAGES_VISITED = 100;
const MAX_PAGE_VALUE = 100_000;
const MAX_TELEMETRY_COUNT = 1_000_000;
const MAX_QUERY_LENGTH = 200;
const MAX_LOCATION_LENGTH = 120;
const MAX_INTENT_LENGTH = 200;
const MAX_ERROR_LENGTH = 320;
const MAX_REASON_LENGTH = 500;
const MAX_GOALS = 20;
const MAX_GOAL_LENGTH = 240;

const protectedTrajectoryEventTypes = new Set(["thinking", "system_prompt", "user_prompt", "assistant_thinking", "assistant_message"]);

export function redactTelemetryText(value: string) {
  return value
    .replace(/(https?:\/\/)([^/\s:@]+)(?::[^/\s@]*)?@/gi, "$1[redacted]@")
    .replace(/(authorization\s*[:=]\s*bearer\s+|bearer\s+)[^\s,}]+/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|apikey|token|secret|password|authorization|credential|credentials|cookie|private[_-]?key|access[_-]?token|client[_-]?secret|refresh[_-]?token)=)[^&\s]*/gi, "$1[redacted]")
    .replace(/([\"']?(?:api[_-]?key|apikey|token|secret|password|authorization|credential|credentials|cookie|private[_-]?key|bearer|client[_-]?secret|refresh[_-]?token)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,}]+/gi, "$1[redacted]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\b(?:system|user|assistant)[ _-](?:prompt|message|thinking|content)\s*[:=]\s*[^|;]+/gi, "[redacted]");
}
const omittedVisiblePayloadKeys = new Set(["text", "content", "prompt", "systemprompt", "userprompt", "assistantmessage", "thinking", "reasoning", "posting", "description", "body", "raw", "rawtext", "result", "results", "summary", "data", "output", "outputs", "apikey", "token", "secret", "password", "authorization", "credential", "credentials", "cookie", "privatekey", "accesstoken", "bearer", "auth", "clientsecret", "refreshtoken", "cursor", "nextcursor"]);
const MAX_VISIBLE_PAYLOAD_DEPTH = 6;
const MAX_VISIBLE_PAYLOAD_KEYS = 80;
const MAX_VISIBLE_PAYLOAD_ITEMS = 50;
const MAX_VISIBLE_PAYLOAD_STRING = 320;

function sanitizeVisiblePayload(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (typeof value === "string") return text(value, MAX_VISIBLE_PAYLOAD_STRING);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > MAX_VISIBLE_PAYLOAD_DEPTH || typeof value !== "object") return "[payload omitted]";
  if (seen.has(value)) return "[circular payload]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_VISIBLE_PAYLOAD_ITEMS).map((item) => sanitizeVisiblePayload(item, seen, depth + 1));
  if (!isJsonRecord(value)) return "[payload omitted]";
  return Object.fromEntries(Object.entries(value).slice(0, MAX_VISIBLE_PAYLOAD_KEYS).flatMap(([key, item]) => {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (omittedVisiblePayloadKeys.has(normalizedKey)) return [];
    return [[text(key, 80) ?? "field", sanitizeVisiblePayload(item, seen, depth + 1)]];
  }));
}

export function sanitizeTrajectoryEvent(event: TrajectoryEvent): TrajectoryEvent {
  return event.kind === "thinking" || protectedTrajectoryEventTypes.has(event.type)
    ? { ...event, payload: null }
    : { ...event, payload: sanitizeVisiblePayload(event.payload, new WeakSet<object>()) };
}


function record(value: unknown): Payload | null {
  return isJsonRecord(value) ? value : null;
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const redacted = redactTelemetryText(normalized).slice(0, limit);
  return redacted || null;
}

function safeError(value: unknown): string | null {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : null;
  if (!message) return null;
  return redactTelemetryText(message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()).slice(0, MAX_ERROR_LENGTH) || null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number | null {
  const valueNumber = finite(value);
  return valueNumber === null ? null : Math.max(0, Math.trunc(valueNumber));
}

function duration(value: unknown): number | null {
  const valueNumber = finite(value);
  return valueNumber === null ? null : Math.max(0, valueNumber);
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function operation(value: unknown, fallback: AttemptOperation | null = null): AttemptOperation | null {
  return value === "search" || value === "detail" ? value : fallback;
}

function eventSequence(event: TrajectoryEvent, fallback: number): number {
  const value = finite(event.sequence);
  return value === null ? fallback : Math.max(0, Math.trunc(value));
}

function eventTimestamp(event: TrajectoryEvent): string | null {
  return text(event.timestamp, 80);
}

function payloadText(payload: Payload | null, key: string, limit: number): string | null {
  return text(payload?.[key], limit);
}

function boundedCount(value: unknown): number | null {
  const parsed = count(value);
  return parsed === null ? null : Math.min(MAX_TELEMETRY_COUNT, parsed);
}
function pageNumber(value: unknown): number | null {
  const parsed = boundedCount(value);
  return parsed === null || parsed < 1 ? null : Math.min(MAX_PAGE_VALUE, parsed);
}

function rate(value: unknown): number | null {
  const parsed = finite(value);
  return parsed === null ? null : Math.min(1, Math.max(0, parsed));
}

function yieldValue(value: unknown): number | null {
  const parsed = finite(value);
  return parsed === null ? null : Math.min(MAX_TELEMETRY_COUNT, Math.max(0, parsed));
}

function payloadPage(payload: Payload | null, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = pageNumber(payload?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function payloadBoundedCount(payload: Payload | null, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = boundedCount(payload?.[key]);
    if (value !== null) return value;
  }
  return null;
}
function payloadNumber(payload: Payload | null, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = finite(payload?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function payloadCount(payload: Payload | null, ...keys: string[]): number | null {
  const value = payloadNumber(payload, ...keys);
  return value === null ? null : Math.max(0, Math.trunc(value));
}

function payloadDuration(payload: Payload | null, event: TrajectoryEvent): number | null {
  return duration(payloadNumber(payload, "latencyMs") ?? event.durationMs);
}

function parseCounts(payload: Payload | null): RunTrajectoryCounts {
  const source = record(payload?.counts);
  return {
    discovered: payloadCount(source, "discovered", "discoveredCount"),
    unique: payloadCount(source, "unique", "uniqueCount", "uniqueJobs"),
    enriched: payloadCount(source, "enriched", "enrichedCount"),
  };
}

function mergeCounts(current: RunTrajectoryCounts, next: RunTrajectoryCounts) {
  if (next.discovered !== null) current.discovered = next.discovered;
  if (next.unique !== null) current.unique = next.unique;
  if (next.enriched !== null) current.enriched = next.enriched;
}

function parseBudget(value: unknown): RunTrajectoryBudget | null {
  const payload = record(value);
  if (!payload) return null;
  const targetUniqueJobs = payloadBoundedCount(payload, "targetUniqueJobs");
  const minSearchesPerSource = payloadBoundedCount(payload, "minSearchesPerSource");
  const maxSearchesPerSource = payloadBoundedCount(payload, "maxSearchesPerSource");
  const maxPagesPerQuery = payloadBoundedCount(payload, "maxPagesPerQuery");
  const maxQueryVariantsPerSource = payloadBoundedCount(payload, "maxQueryVariantsPerSource");
  return {
    maxSearchCalls: payloadBoundedCount(payload, "maxSearchCalls"),
    maxDetailCalls: payloadBoundedCount(payload, "maxDetailCalls"),
    maxTotalResults: payloadBoundedCount(payload, "maxTotalResults"),
    maxRunDurationMs: duration(payloadNumber(payload, "maxRunDurationMs")),
    ...(targetUniqueJobs === null ? {} : { targetUniqueJobs }),
    ...(minSearchesPerSource === null ? {} : { minSearchesPerSource }),
    ...(maxSearchesPerSource === null ? {} : { maxSearchesPerSource }),
    ...(maxPagesPerQuery === null ? {} : { maxPagesPerQuery }),
    ...(maxQueryVariantsPerSource === null ? {} : { maxQueryVariantsPerSource }),
  };
}
function parseAdaptiveAttemptFields(payload: Payload | null): Partial<RunTrajectoryAttempt> {
  const pageInfo = record(payload?.pageInfo);
  const page = payloadPage(payload, "page") ?? payloadPage(pageInfo, "page");
  const cursor = payloadText(payload, "cursor", MAX_CURSOR_LENGTH) ?? payloadText(pageInfo, "cursor", MAX_CURSOR_LENGTH);
  const hasMore = bool(payload?.hasMore) ?? bool(pageInfo?.hasMore);
  const nextPage = payloadPage(payload, "nextPage") ?? payloadPage(pageInfo, "nextPage");
  const nextCursor = payloadText(payload, "nextCursor", MAX_CURSOR_LENGTH) ?? payloadText(pageInfo, "nextCursor", MAX_CURSOR_LENGTH);
  const total = payloadBoundedCount(payload, "total") ?? payloadBoundedCount(pageInfo, "total");
  return {
    ...(page === null ? {} : { page }),
    ...(cursor === null ? {} : { cursor: "[redacted]" }),
    ...(hasMore === null ? {} : { hasMore }),
    ...(nextPage === null ? {} : { nextPage }),
    ...(nextCursor === null ? {} : { nextCursor: "[redacted]" }),
    ...(total === null ? {} : { total }),
  };
}

function parsePages(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const pages = value.map(pageNumber).filter((item): item is number => item !== null);
  return pages.length ? [...new Set(pages)].slice(0, MAX_PAGES_VISITED) : null;
}

function parseQueryRecord(value: unknown, fallbackSource: string | null = null): RunTrajectoryQueryRecord | null {
  const payload = record(value);
  if (!payload) return null;
  const source = payloadText(payload, "source", MAX_SOURCE_LENGTH) ?? fallbackSource;
  const query = payloadText(payload, "query", MAX_QUERY_LENGTH);
  const location = payloadText(payload, "location", MAX_LOCATION_LENGTH);
  const { page, cursor, hasMore, nextPage, nextCursor, total } = parseAdaptiveAttemptFields(payload);
  const returnedHits = payloadBoundedCount(payload, "returnedHits", "resultCount", "rawHits", "raw");
  const uniqueHits = payloadBoundedCount(payload, "uniqueHits", "uniqueResultCount", "uniqueCount", "unique");
  const duplicateRate = rate(payload?.duplicateRate);
  const fields: RunTrajectoryQueryRecord = {
    ...(source === null ? {} : { source }),
    ...(query === null ? {} : { query }),
    ...(location === null ? {} : { location }),
    ...(page === undefined ? {} : { page }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(returnedHits === null ? {} : { returnedHits }),
    ...(uniqueHits === null ? {} : { uniqueHits }),
    ...(duplicateRate === null ? {} : { duplicateRate }),
    ...(hasMore === undefined ? {} : { hasMore }),
    ...(nextPage === undefined ? {} : { nextPage }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(total === undefined ? {} : { total }),
  };
  return Object.keys(fields).length ? fields : null;
}

function parsePath(value: unknown): RunTrajectoryPath | null {
  const payload = record(value);
  if (!payload) return null;
  const recordValue = parseQueryRecord(payload);
  const path = payloadText(payload, "path", MAX_ID_LENGTH);
  const safePath = path !== null && (recordValue?.cursor !== undefined || recordValue?.nextCursor !== undefined) ? "[redacted]" : path;
  const searches = payloadBoundedCount(payload, "searches");
  const completed = bool(payload.completed);
  const pagesVisited = parsePages(payload.pagesVisited);
  const raw = payloadBoundedCount(payload, "raw");
  const unique = payloadBoundedCount(payload, "unique");
  const duplicate = payloadBoundedCount(payload, "duplicate");
  const averageYield = yieldValue(payload.averageYield);
  const lastYield = yieldValue(payload.lastYield);
  if (!recordValue && safePath === null && searches === null && completed === null && pagesVisited === null && raw === null && unique === null && duplicate === null && averageYield === null && lastYield === null) return null;
  return {
    ...(recordValue ?? {}),
    ...(safePath === null ? {} : { path: safePath }),
    ...(searches === null ? {} : { searches }),
    ...(completed === null ? {} : { completed }),
    ...(pagesVisited === null ? {} : { pagesVisited }),
    ...(raw === null ? {} : { raw }),
    ...(unique === null ? {} : { unique }),
    ...(duplicate === null ? {} : { duplicate }),
    ...(averageYield === null ? {} : { averageYield }),
    ...(lastYield === null ? {} : { lastYield }),
  };
}

function parsePaths(value: unknown): RunTrajectoryPath[] | null {
  if (!Array.isArray(value)) return null;
  const paths = value.map(parsePath).filter((item): item is RunTrajectoryPath => item !== null);
  return paths.length ? paths.slice(0, MAX_QUERY_HISTORY) : null;
}

function parseNextSearch(value: unknown): RunTrajectoryNextSearch | null {
  const payload = record(value);
  if (!payload) return null;
  const recordValue = parseQueryRecord(payload);
  if (!recordValue) return null;
  const limit = payloadBoundedCount(payload, "limit");
  const reason = text(payload.reason, MAX_REASON_LENGTH);
  return { ...recordValue, ...(limit === null ? {} : { limit }), ...(reason === null ? {} : { reason }) };
}
function parseStateAdaptive(payload: Payload | null): Pick<RunTrajectoryStateSnapshot, "nextSearch" | "plannerStop" | "queryHistory" | "paths"> {
  const plannerStop = text(payload?.plannerStop, 80);
  const queryHistory = Array.isArray(payload?.queryHistory)
    ? payload.queryHistory.map((item) => text(item, MAX_QUERY_LENGTH)).filter((item): item is string => item !== null).slice(0, MAX_QUERY_HISTORY)
    : null;
  const nextSearch = parseNextSearch(payload?.nextSearch);
  const paths = parsePaths(payload?.paths);
  return {
    ...(nextSearch ? { nextSearch } : {}),
    ...(plannerStop ? { plannerStop } : {}),
    ...(queryHistory?.length ? { queryHistory } : {}),
    ...(paths ? { paths } : {}),
  };
}


function parseNumberMap(value: unknown): Record<string, number> | null {
  if (!isJsonRecord(value)) return null;
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_SOURCES)) {
    const name = text(key, MAX_SOURCE_LENGTH);
    const numberValue = boundedCount(item);
    if (name && numberValue !== null) result[name] = numberValue;
  }
  return Object.keys(result).length ? result : null;
}
function parseStringMap(value: unknown): Record<string, string[]> | null {
  if (!isJsonRecord(value)) return null;
  const result: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_SOURCES)) {
    const name = text(key, MAX_SOURCE_LENGTH);
    if (!name || !Array.isArray(item)) continue;
    const values = item.map(entry => text(entry, MAX_QUERY_LENGTH)).filter((entry): entry is string => entry !== null);
    if (values.length) result[name] = [...new Set(values)].slice(0, MAX_QUERY_HISTORY);
  }
  return Object.keys(result).length ? result : null;
}

function parsePageMap(value: unknown): Record<string, number[]> | null {
  if (!isJsonRecord(value)) return null;
  const result: Record<string, number[]> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_SOURCES)) {
    const name = text(key, MAX_SOURCE_LENGTH);
    const pages = parsePages(item);
    if (name && pages) result[name] = pages;
  }
  return Object.keys(result).length ? result : null;
}

function parseFunnel(payload: Payload | null): RunTrajectoryFunnel | null {
  const candidate = record(payload?.funnel) ?? payload;
  if (!candidate) return null;
  const enabledSources = Array.isArray(candidate.enabledSources)
    ? candidate.enabledSources.map((item) => text(item, MAX_SOURCE_LENGTH)).filter((item): item is string => item !== null).slice(0, MAX_SOURCES)
    : null;
  const sourceAttempts = boundedCount(candidate.sourceAttempts) ?? parseNumberMap(candidate.sourceAttempts);
  const queriesBySource = parseStringMap(candidate.queriesBySource);
  const pagesBySource = parsePageMap(candidate.pagesBySource);
  const sourceValues = new Map<string, SourceAccumulator>();
  mergeStateSourceStats(sourceValues, candidate.sources);
  const sources = sourceValues.size
    ? Object.fromEntries([...sourceValues.entries()].slice(0, MAX_SOURCES).map(([source, value]) => [source, sourceOutput(value)]))
    : null;
  const rawHits = boundedCount(candidate.rawHits);
  const uniqueHits = boundedCount(candidate.uniqueHits);
  const promisingHits = boundedCount(candidate.promisingHits);
  const candidatesAfterCheapFiltering = boundedCount(candidate.candidatesAfterCheapFiltering);
  const detailFetches = boundedCount(candidate.detailFetches);
  const selectedJobs = boundedCount(candidate.selectedJobs);
  const stopReason = text(candidate.stopReason ?? candidate.reason, MAX_REASON_LENGTH);
  const result: RunTrajectoryFunnel = {
    ...(enabledSources?.length ? { enabledSources } : {}),
    ...(sourceAttempts ? { sourceAttempts } : {}),
    ...(queriesBySource ? { queriesBySource } : {}),
    ...(pagesBySource ? { pagesBySource } : {}),
    ...(rawHits === null ? {} : { rawHits }),
    ...(uniqueHits === null ? {} : { uniqueHits }),
    ...(promisingHits === null ? {} : { promisingHits }),
    ...(candidatesAfterCheapFiltering === null ? {} : { candidatesAfterCheapFiltering }),
    ...(detailFetches === null ? {} : { detailFetches }),
    ...(selectedJobs === null ? {} : { selectedJobs }),
    ...(stopReason === null ? {} : { stopReason }),
    ...(sources ? { sources } : {}),
  };
  return Object.keys(result).length ? result : null;
}

function parseMarginalUtility(value: unknown) {
  const payload = record(value);
  if (!payload) return null;
  return {
    score: finite(payload.score),
    recentSearches: payloadCount(payload, "recentSearches"),
    recentUniqueJobs: payloadCount(payload, "recentUniqueJobs"),
    recentPromisingJobs: payloadCount(payload, "recentPromisingJobs"),
    repeatedZeroYieldSearches: payloadCount(payload, "repeatedZeroYieldSearches"),
    status: text(payload.status, 40),
    recommendation: text(payload.recommendation, 240),
  };
}

function parseCoverage(value: unknown): Record<string, string> | null {
  if (!isJsonRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    const name = text(key, 120);
    const level = text(item, 40);
    if (name && level) result[name] = level;
  }
  return Object.keys(result).length ? result : null;
}
function parseSourceCoverage(value: unknown): RunTrajectorySourceCoverage | null {
  if (!isJsonRecord(value)) return null;
  const list = (key: string) => Array.isArray(value[key])
    ? value[key].map(item => text(item, MAX_SOURCE_LENGTH)).filter((item): item is string => item !== null).slice(0, MAX_SOURCES)
    : [];
  if (!["required", "searched", "unavailable", "unsearched"].some(key => Array.isArray(value[key]))) return null;
  return {
    required: list("required"),
    searched: list("searched"),
    unavailable: list("unavailable"),
    unsearched: list("unsearched"),
  };
}

function parseGoals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, MAX_GOAL_LENGTH)).filter((item): item is string => item !== null).slice(0, MAX_GOALS);
}

function parseTermination(payload: Payload | null): RunTrajectoryTermination | null {
  if (!payload) return null;
  const reason = text(payload.reason, MAX_REASON_LENGTH);
  const category = text(payload.reasonCategory ?? payload.category, 80);
  const unresolvedGoals = parseGoals(payload.unresolvedGoals);
  const unresolvedGoalCount = payloadCount(payload, "unresolvedGoalCount") ?? (Array.isArray(payload.unresolvedGoals) ? unresolvedGoals.length : null);
  if (!reason && !category && !unresolvedGoals.length && unresolvedGoalCount === null) return null;
  return { reason, category, unresolvedGoals, unresolvedGoalCount };
}

function sourceValue(payload: Payload | null): string | null {
  return payloadText(payload, "source", MAX_SOURCE_LENGTH);
}

function sourceIdValue(payload: Payload | null): string | null {
  return payloadText(payload, "sourceId", MAX_ID_LENGTH);
}

function resultIdValue(payload: Payload | null): string | null {
  return payloadText(payload, "resultId", MAX_ID_LENGTH) ?? sourceIdValue(payload);
}

function attemptIdValue(payload: Payload | null): string | null {
  return payloadText(payload, "attemptId", 80);
}

function attemptErrorCategory(type: string, payload: Payload | null): string | null {
  const declared = payloadText(payload, "errorCategory", 80) ?? payloadText(payload, "errorCode", 80);
  if (declared) return declared;
  if (type.includes("provenance")) return "provenance";
  if (type.includes("budget")) return "budget";
  if (type.includes("source_rejected")) return "disabled_source";
  if (type.endsWith("_failed")) return "provider";
  return null;
}

function emptyAttempt(operationValue: AttemptOperation, sequence: number, timestamp: string | null): RunTrajectoryAttempt {
  return {
    sequence,
    attemptId: null,
    operation: operationValue,
    status: "started",
    source: null,
    query: null,
    location: null,
    intent: null,
    sourceId: null,
    resultId: null,
    requestedLimit: null,
    resultCount: null,
    uniqueResultCount: null,
    duplicateCount: null,
    promisingResultCount: null,
    enrichedCount: null,
    promising: null,
    repeatCount: null,
    latencyMs: null,
    duplicateRate: null,
    uniqueYield: null,
    promisingYield: null,
    error: null,
    errorCategory: null,
    timestamp,
  };
}

function attemptKey(operationValue: AttemptOperation, source: string | null, identifier: string | null) {
  return `${operationValue}\u0000${source ?? ""}\u0000${identifier ?? ""}`;
}

function pendingAttempt(
  attempts: readonly RunTrajectoryAttempt[],
  queues: ReadonlyMap<string, AttemptIndex[]>,
  operationValue: AttemptOperation,
  source: string | null,
  identifier: string | null,
): AttemptIndex | null {
  const exact = queues.get(attemptKey(operationValue, source, identifier));
  if (exact) {
    const index = exact.find((candidate) => attempts[candidate]?.status === "started");
    if (index !== undefined) return index;
  }
  const fallback = queues.get(attemptKey(operationValue, source, null));
  if (!fallback) return null;
  const index = fallback.find((candidate) => attempts[candidate]?.status === "started");
  return index === undefined ? null : index;
}

function setAttemptDerivedFields(attempt: RunTrajectoryAttempt) {
  if (attempt.resultCount !== null) {
    attempt.uniqueYield = attempt.uniqueResultCount === null ? null : attempt.uniqueResultCount / Math.max(1, attempt.resultCount);
    attempt.promisingYield = attempt.promisingResultCount === null ? null : attempt.promisingResultCount / Math.max(1, attempt.resultCount);
    attempt.duplicateRate = attempt.duplicateCount === null ? null : attempt.duplicateCount / Math.max(1, attempt.resultCount);
  }
}

function sourceStats(): SourceAccumulator {
  return {
    searchCalls: null,
    detailCalls: null,
    rawHits: null,
    uniqueCount: null,
    duplicateCount: null,
    duplicateRate: null,
    promisingCount: null,
    enrichedCount: null,
    failures: null,
    latencyTotal: 0,
    latencySamples: 0,
    searches: null,
    uniqueHits: null,
    promisingHits: null,
    averageYield: null,
    lastYield: null,
    pagesVisited: null,
    queryHistory: null,
  };
}

function increment(value: number | null, amount = 1) {
  return (value ?? 0) + amount;
}
function hasAdaptiveAttemptTelemetry(attempt: RunTrajectoryAttempt) {
  return attempt.page !== undefined || attempt.cursor !== undefined || attempt.hasMore !== undefined || attempt.nextPage !== undefined || attempt.nextCursor !== undefined || attempt.total !== undefined;
}

function attemptQueryRecord(attempt: RunTrajectoryAttempt): RunTrajectoryQueryRecord | null {
  if (!hasAdaptiveAttemptTelemetry(attempt)) return null;
  return parseQueryRecord({
    source: attempt.source,
    query: attempt.query,
    location: attempt.location,
    page: attempt.page,
    cursor: attempt.cursor,
    returnedHits: attempt.resultCount,
    uniqueHits: attempt.uniqueResultCount,
    duplicateRate: attempt.duplicateRate,
    hasMore: attempt.hasMore,
    nextPage: attempt.nextPage,
    nextCursor: attempt.nextCursor,
    total: attempt.total,
  });
}

function mergeQueryRecord(stats: SourceAccumulator, next: RunTrajectoryQueryRecord) {
  const history = stats.queryHistory ?? [];
  const samePath = (item: RunTrajectoryQueryRecord) => item.source === next.source && item.query === next.query && item.location === next.location && item.page === next.page && item.cursor === next.cursor;
  const index = history.findIndex(samePath);
  if (index >= 0) history[index] = { ...history[index], ...next };
  else history.push(next);
  stats.queryHistory = history.slice(-MAX_QUERY_HISTORY);
}

function addPage(stats: SourceAccumulator, page: number | undefined) {
  if (page === undefined) return;
  const pages = stats.pagesVisited ?? [];
  if (!pages.includes(page)) pages.push(page);
  stats.pagesVisited = pages.slice(-MAX_PAGES_VISITED);
}


function addLatency(stats: SourceAccumulator, value: number | null) {
  if (value === null) return;
  stats.latencyTotal += value;
  stats.latencySamples += 1;
}

function updateSourceStats(
  stats: SourceAccumulator,
  operationValue: AttemptOperation,
  status: RunTrajectoryAttemptStatus,
  attempt: RunTrajectoryAttempt,
) {
  if (operationValue === "search") {
    if (status === "started") stats.searchCalls = increment(stats.searchCalls);
    if (attempt.resultCount !== null) stats.rawHits = increment(stats.rawHits, attempt.resultCount);
    if (attempt.uniqueResultCount !== null) stats.uniqueCount = increment(stats.uniqueCount, attempt.uniqueResultCount);
    if (attempt.duplicateCount !== null) stats.duplicateCount = increment(stats.duplicateCount, attempt.duplicateCount);
    if (attempt.promisingResultCount !== null) stats.promisingCount = increment(stats.promisingCount, attempt.promisingResultCount);
    if (hasAdaptiveAttemptTelemetry(attempt)) {
      if (status === "started") stats.searches = increment(stats.searches);
      else if (stats.searches === null) stats.searches = 1;
      addPage(stats, attempt.page);
      const recordValue = attemptQueryRecord(attempt);
      if (recordValue) mergeQueryRecord(stats, recordValue);
      if (status !== "started" && attempt.uniqueResultCount !== null) {
        const searches = stats.searches ?? 1;
        stats.uniqueHits = increment(stats.uniqueHits, attempt.uniqueResultCount);
        stats.promisingHits = attempt.promisingResultCount === null ? stats.promisingHits : increment(stats.promisingHits, attempt.promisingResultCount);
        stats.lastYield = attempt.uniqueResultCount;
        stats.averageYield = ((stats.averageYield ?? 0) * Math.max(0, searches - 1) + attempt.uniqueResultCount) / searches;
      }
    }
  } else if (status === "started") {
    stats.detailCalls = increment(stats.detailCalls);
  }
  if (status === "failed" || status === "rejected") stats.failures = increment(stats.failures);
  addLatency(stats, attempt.latencyMs);
  if (stats.rawHits !== null && stats.duplicateCount !== null) stats.duplicateRate = stats.duplicateCount / Math.max(1, stats.rawHits);
  if (attempt.enrichedCount !== null) stats.enrichedCount = Math.max(stats.enrichedCount ?? 0, attempt.enrichedCount);
}
function mergeStateSourceStats(sources: Map<string, SourceAccumulator>, value: unknown) {
  if (!isJsonRecord(value)) return;
  for (const [sourceName, raw] of Object.entries(value).slice(0, MAX_SOURCES)) {
    const source = text(sourceName, MAX_SOURCE_LENGTH);
    const stats = record(raw);
    if (!source || !stats) continue;
    const target = sources.get(source) ?? sourceStats();
    const setCount = (key: "searchCalls" | "detailCalls" | "rawHits" | "uniqueCount" | "duplicateCount" | "promisingCount" | "enrichedCount" | "failures", next: number | null) => {
      if (next !== null) target[key] = next;
    };
    setCount("searchCalls", payloadBoundedCount(stats, "searchCalls"));
    setCount("detailCalls", payloadBoundedCount(stats, "detailCalls"));
    setCount("rawHits", payloadBoundedCount(stats, "rawHits", "discoveredCount"));
    setCount("uniqueCount", payloadBoundedCount(stats, "uniqueCount", "uniqueJobs"));
    setCount("duplicateCount", payloadBoundedCount(stats, "duplicateCount"));
    const duplicateRate = rate(stats.duplicateRate);
    if (duplicateRate !== null) target.duplicateRate = duplicateRate;
    setCount("promisingCount", payloadBoundedCount(stats, "promisingJobs", "promisingCount"));
    setCount("enrichedCount", payloadBoundedCount(stats, "enrichedCount"));
    setCount("failures", payloadBoundedCount(stats, "errors", "failures"));
    const searches = payloadBoundedCount(stats, "searches");
    const uniqueHits = payloadBoundedCount(stats, "uniqueHits");
    const promisingHits = payloadBoundedCount(stats, "promisingHits");
    const averageYield = yieldValue(stats.averageYield);
    const lastYield = yieldValue(stats.lastYield);
    const pagesVisited = parsePages(stats.pagesVisited);
    if (searches !== null) target.searches = searches;
    if (uniqueHits !== null) target.uniqueHits = uniqueHits;
    if (promisingHits !== null) target.promisingHits = promisingHits;
    if (averageYield !== null) target.averageYield = averageYield;
    if (lastYield !== null) target.lastYield = lastYield;
    if (pagesVisited !== null) target.pagesVisited = pagesVisited;
    if (Array.isArray(stats.queryHistory)) {
      for (const item of stats.queryHistory) {
        const queryRecord = parseQueryRecord(item, source);
        if (queryRecord) mergeQueryRecord(target, queryRecord);
      }
    }
    sources.set(source, target);
  }
}
function mergeStatePaths(sources: Map<string, SourceAccumulator>, value: unknown) {
  const paths = parsePaths(value);
  if (!paths) return;
  for (const path of paths) {
    const source = text(path.source, MAX_SOURCE_LENGTH);
    if (!source) continue;
    const target = sources.get(source) ?? sourceStats();
    if (target.searches === null && path.searches !== undefined) target.searches = path.searches;
    if (target.averageYield === null && path.averageYield !== undefined) target.averageYield = path.averageYield;
    if (target.lastYield === null && path.lastYield !== undefined) target.lastYield = path.lastYield;
    if (path.pagesVisited) target.pagesVisited = [...new Set([...(target.pagesVisited ?? []), ...path.pagesVisited])].slice(0, MAX_PAGES_VISITED);
    const queryRecord = parseQueryRecord(path, source);
    if (queryRecord) mergeQueryRecord(target, queryRecord);
    sources.set(source, target);
  }
}


function sourceOutput(value: SourceAccumulator): RunTrajectorySourceStats {
  return {
    searchCalls: value.searchCalls,
    detailCalls: value.detailCalls,
    rawHits: value.rawHits,
    uniqueCount: value.uniqueCount,
    duplicateCount: value.duplicateCount,
    duplicateRate: value.duplicateRate,
    promisingCount: value.promisingCount,
    enrichedCount: value.enrichedCount,
    failures: value.failures,
    latencyMs: value.latencySamples ? value.latencyTotal / value.latencySamples : null,
    ...(value.searches === null ? {} : { searches: value.searches }),
    ...(value.uniqueHits === null ? {} : { uniqueHits: value.uniqueHits }),
    ...(value.promisingHits === null ? {} : { promisingHits: value.promisingHits }),
    ...(value.averageYield === null ? {} : { averageYield: value.averageYield }),
    ...(value.lastYield === null ? {} : { lastYield: value.lastYield }),
    ...(value.pagesVisited === null ? {} : { pagesVisited: value.pagesVisited.slice(0, MAX_PAGES_VISITED) }),
    ...(value.queryHistory === null ? {} : { queryHistory: value.queryHistory.slice(0, MAX_QUERY_HISTORY) }),
  };
}

function usageFromPayload(payload: Payload | null) {
  const usage = record(payload?.usage);
  if (!usage) return null;
  const inputTokens = finite(usage.inputTokens) ?? finite(usage.input);
  const outputTokens = finite(usage.outputTokens) ?? finite(usage.output);
  const totalTokens = finite(usage.totalTokens) ?? finite(usage.total) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cost = record(usage.cost);
  const estimatedCost = finite(usage.estimatedCost) ?? finite(cost?.total);
  if (inputTokens === null && outputTokens === null && totalTokens === null && estimatedCost === null) return null;
  return { inputTokens, outputTokens, totalTokens, estimatedCost };
}

function aggregateUsage(events: readonly TrajectoryEvent[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasTotal = false;
  let hasCost = false;
  for (const event of events) {
    if (event.type !== "assistant_message" && event.type !== "assistant_thinking") continue;
    const usage = usageFromPayload(record(event.payload));
    if (!usage) continue;
    if (usage.inputTokens !== null) { inputTokens += usage.inputTokens; hasInput = true; }
    if (usage.outputTokens !== null) { outputTokens += usage.outputTokens; hasOutput = true; }
    if (usage.totalTokens !== null) { totalTokens += usage.totalTokens; hasTotal = true; }
    if (usage.estimatedCost !== null) { estimatedCost += usage.estimatedCost; hasCost = true; }
  }
  return {
    inputTokens: hasInput ? inputTokens : null,
    outputTokens: hasOutput ? outputTokens : null,
    totalTokens: hasTotal ? totalTokens : null,
    estimatedCost: hasCost ? estimatedCost : null,
  };
}

function runDuration(run: Pick<Run, "started_at" | "finished_at">): number | null {
  if (!run.finished_at) return null;
  const start = Date.parse(run.started_at);
  const end = Date.parse(run.finished_at);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function policyCategory(type: string, payload: Payload | null): string | null {
  if (type.includes("provenance")) return "provenance_rejection";
  if (type.includes("budget")) return "budget_rejection";
  if (type.includes("source_rejected")) return "disabled_source_rejection";
  if (type === "run_timed_out") return "timeout";
  if (type === "run_cancelled") return "cancellation";
  if (type === "run_failed" || payloadText(payload, "errorCode", 80) === "provider") return "provider_failure";
  if (type.includes("malformed") || type.includes("invalid")) return "tool_validation";
  if (type === "search_failed" || type === "detail_failed") return "source_failure";
  return null;
}

function policyEvent(event: TrajectoryEvent, payload: Payload | null): RunTrajectoryPolicyEvent | null {
  const category = policyCategory(event.type, payload);
  if (!category) return null;
  const declaredOperation = operation(payload?.operation);
  const inferredOperation = event.type.startsWith("detail") ? "detail" : event.type.startsWith("search") ? "search" : null;
  return {
    sequence: eventSequence(event, 0),
    type: text(event.type, 100) ?? "unknown",
    category,
    operation: declaredOperation ?? inferredOperation,
    source: sourceValue(payload),
    reason: text(payload?.reason ?? payload?.errorCode, 120),
    error: safeError(payload?.error),
  };
}

function adaptationReason(previous: RunTrajectoryAttempt, current: RunTrajectoryAttempt) {
  if (previous.source !== current.source) return "source_switch";
  if (previous.error || current.error) return "error_recovery";
  if ((previous.duplicateRate ?? 0) >= 0.5 || previous.uniqueResultCount === 0 || previous.promisingResultCount === 0) return "low_yield";
  return "query_change";
}

function adaptationSignal(previous: RunTrajectoryAttempt) {
  if (previous.error) return previous.error;
  if ((previous.duplicateRate ?? 0) >= 0.5) return "duplicate-heavy results";
  if (previous.uniqueResultCount === 0) return "no unique results";
  if (previous.promisingResultCount === 0) return "no promising results";
  return null;
}

function deriveAdaptations(attempts: readonly RunTrajectoryAttempt[]): RunTrajectoryAdaptation[] {
  const result: RunTrajectoryAdaptation[] = [];
  let previous: RunTrajectoryAttempt | null = null;
  for (const attempt of attempts) {
    if (attempt.operation !== "search" || !["completed", "failed"].includes(attempt.status)) continue;
    if (previous && (previous.source !== attempt.source || previous.query !== attempt.query || previous.location !== attempt.location)) {
      result.push({
        sequence: attempt.sequence,
        from: { source: previous.source, query: previous.query, location: previous.location },
        to: { source: attempt.source, query: attempt.query, location: attempt.location },
        reason: adaptationReason(previous, attempt),
        signal: adaptationSignal(previous),
      });
      if (result.length >= MAX_ADAPTATIONS) break;
    }
    previous = attempt;
  }
  return result;
}

function terminalTermination(run: Pick<Run, "status" | "error">, events: readonly TrajectoryEvent[]): RunTrajectoryTermination | null {
  if (run.status === "succeeded") {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "run_completed") return { reason: "Run completed.", category: "agent_finished", unresolvedGoals: [], unresolvedGoalCount: null };
    }
    return { reason: "Run completed.", category: "agent_finished", unresolvedGoals: [], unresolvedGoalCount: null };
  }
  const terminalType = run.status === "cancelled" ? "run_cancelled" : run.status === "timed_out" ? "run_timed_out" : run.status === "failed" ? "run_failed" : null;
  if (!terminalType) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== terminalType) continue;
    const payload = record(event.payload);
    const error = safeError(payload?.error) ?? safeError(run.error);
    if (run.status === "cancelled") return { reason: error ?? "Run cancelled.", category: "cancelled", unresolvedGoals: [], unresolvedGoalCount: null };
    if (run.status === "timed_out") return { reason: error ?? "Run timed out.", category: "timeout", unresolvedGoals: [], unresolvedGoalCount: null };
    return { reason: error ?? "Run failed.", category: payloadText(payload, "errorCode", 80) ?? "failed", unresolvedGoals: [], unresolvedGoalCount: null };
  }
  if (run.status === "cancelled") return { reason: safeError(run.error) ?? "Run cancelled.", category: "cancelled", unresolvedGoals: [], unresolvedGoalCount: null };
  if (run.status === "timed_out") return { reason: safeError(run.error) ?? "Run timed out.", category: "timeout", unresolvedGoals: [], unresolvedGoalCount: null };
  return { reason: safeError(run.error) ?? "Run failed.", category: "failed", unresolvedGoals: [], unresolvedGoalCount: null };
}

export function deriveRunTrajectoryObservability(
  run: Pick<Run, "workflow" | "status" | "started_at" | "finished_at" | "error" | "input_tokens" | "output_tokens" | "total_tokens" | "estimated_cost">,
  events: readonly TrajectoryEvent[],
): RunTrajectoryObservability {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => eventSequence(left.event, left.index) - eventSequence(right.event, right.index) || left.index - right.index)
    .map(({ event }) => event);
  const attempts: RunTrajectoryAttempt[] = [];
  const queues = new Map<string, AttemptIndex[]>();
  const attemptsById = new Map<string, AttemptIndex>();
  const sources = new Map<string, SourceAccumulator>();
  const states: RunTrajectoryStateSnapshot[] = [];
  const policyEvents: RunTrajectoryPolicyEvent[] = [];
  let counts: RunTrajectoryCounts = { discovered: null, unique: null, enriched: null };
  let searchTermination: RunTrajectoryTermination | null = null;
  let configuredBudget: RunTrajectoryBudget | null = null;

  const queueAttempt = (index: AttemptIndex, operationValue: AttemptOperation, source: string | null, identifier: string | null) => {
    const key = attemptKey(operationValue, source, identifier);
    const queue = queues.get(key) ?? [];
    queue.push(index);
    queues.set(key, queue);
    if (identifier) attemptsById.set(identifier, index);
  };
  let funnel: RunTrajectoryFunnel | undefined;
  const sourceFor = (source: string | null) => {
    if (!source) return null;
    const existing = sources.get(source);
    if (existing) return existing;
    if (sources.size >= MAX_SOURCES) return null;
    const created = sourceStats();
    sources.set(source, created);
    return created;
  };

  const create = (operationValue: AttemptOperation, event: TrajectoryEvent, payload: Payload | null) => {
    if (attempts.length >= MAX_ATTEMPTS) return null;
    const row = emptyAttempt(operationValue, eventSequence(event, attempts.length), eventTimestamp(event));
    row.attemptId = attemptIdValue(payload);
    row.source = sourceValue(payload);
    row.query = payloadText(payload, "query", MAX_QUERY_LENGTH);
    row.location = payloadText(payload, "location", MAX_LOCATION_LENGTH);
    row.intent = payloadText(payload, "intent", MAX_INTENT_LENGTH);
    row.sourceId = sourceIdValue(payload);
    row.resultId = resultIdValue(payload);
    row.requestedLimit = payloadCount(payload, "requestedLimit", "limit");
    row.repeatCount = payloadCount(payload, "repeatCount");
    Object.assign(row, parseAdaptiveAttemptFields(payload));
    const index = attempts.push(row) - 1;
    queueAttempt(index, operationValue, row.source, operationValue === "detail" ? row.sourceId ?? row.resultId : null);
    return index;
  };

  const resolve = (operationValue: AttemptOperation, event: TrajectoryEvent, payload: Payload | null) => {
    const id = attemptIdValue(payload);
    if (id) {
      const byId = attemptsById.get(id);
      if (byId !== undefined && attempts[byId]?.operation === operationValue) return byId;
    }
    return pendingAttempt(attempts, queues, operationValue, sourceValue(payload), operationValue === "detail" ? sourceIdValue(payload) ?? resultIdValue(payload) : null) ?? create(operationValue, event, payload);
  };

  const updateAttempt = (index: AttemptIndex | null, event: TrajectoryEvent, payload: Payload | null, status: RunTrajectoryAttemptStatus) => {
    if (index === null || index === undefined) return;
    const attempt = attempts[index];
    if (!attempt) return;
    const previousStatus = attempt.status;
    const nextSource = sourceValue(payload);
    if (nextSource) attempt.source = nextSource;
    const nextAttemptId = attemptIdValue(payload);
    if (nextAttemptId) attempt.attemptId = nextAttemptId;
    const query = payloadText(payload, "query", MAX_QUERY_LENGTH);
    const location = payloadText(payload, "location", MAX_LOCATION_LENGTH);
    const intent = payloadText(payload, "intent", MAX_INTENT_LENGTH);
    if (query) attempt.query = query;
    if (location) attempt.location = location;
    if (intent) attempt.intent = intent;
    const sourceId = sourceIdValue(payload);
    const resultId = resultIdValue(payload);
    if (sourceId) attempt.sourceId = sourceId;
    if (resultId) attempt.resultId = resultId;
    const requestedLimit = payloadCount(payload, "requestedLimit", "limit");
    if (requestedLimit !== null) attempt.requestedLimit = requestedLimit;
    const resultCount = payloadCount(payload, "resultCount", "rawResultCount");
    const uniqueResultCount = payloadCount(payload, "uniqueResultCount", "uniqueCount");
    const duplicateCount = payloadCount(payload, "duplicateCount", "duplicates");
    const promisingResultCount = payloadCount(payload, "promisingResultCount", "promisingCount");
    const enrichedCount = payloadCount(payload, "enrichedCount");
    if (resultCount !== null) attempt.resultCount = resultCount;
    if (uniqueResultCount !== null) attempt.uniqueResultCount = uniqueResultCount;
    if (duplicateCount !== null) attempt.duplicateCount = duplicateCount;
    if (promisingResultCount !== null) attempt.promisingResultCount = promisingResultCount;
    Object.assign(attempt, parseAdaptiveAttemptFields(payload));
    if (enrichedCount !== null) attempt.enrichedCount = enrichedCount;
    const promising = bool(payload?.promising);
    if (promising !== null) attempt.promising = promising;
    const repeatCount = payloadCount(payload, "repeatCount");
    if (repeatCount !== null) attempt.repeatCount = repeatCount;
    const latencyMs = payloadDuration(payload, event);
    if (latencyMs !== null) attempt.latencyMs = latencyMs;
    const error = safeError(payload?.error);
    if (error) attempt.error = error;
    const category = attemptErrorCategory(event.type, payload);
    if (category) attempt.errorCategory = category;
    attempt.status = status;
    setAttemptDerivedFields(attempt);
    if (previousStatus === "started" || status === "started") updateSourceStats(sourceFor(attempt.source) ?? sourceStats(), attempt.operation, status, attempt);
  };

  const addPolicy = (event: TrajectoryEvent, payload: Payload | null) => {
    if (policyEvents.length >= MAX_POLICY_EVENTS) return;
    const next = policyEvent(event, payload);
    if (next) policyEvents.push(next);
  };

  for (const event of ordered) {
    const payload = record(event.payload);
    const eventBudget = parseBudget(payload?.budget);
    if (configuredBudget === null && eventBudget !== null) configuredBudget = eventBudget;
    const operationValue = operation(payload?.operation);
    if (event.type === "search_started") {
      const index = resolve("search", event, payload);
      updateAttempt(index, event, payload, "started");
    } else if (event.type === "search_completed") {
      const index = resolve("search", event, payload);
      updateAttempt(index, event, payload, "completed");
      mergeCounts(counts, parseCounts(payload));
    } else if (event.type === "search_failed") {
      const index = resolve("search", event, payload);
      updateAttempt(index, event, payload, "failed");
      addPolicy(event, payload);
    } else if (event.type === "detail_started") {
      const index = resolve("detail", event, payload);
      updateAttempt(index, event, payload, "started");
    } else if (event.type === "detail_completed") {
      const index = resolve("detail", event, payload);
      updateAttempt(index, event, payload, "completed");
      mergeCounts(counts, parseCounts(payload));
    } else if (event.type === "detail_failed") {
      const index = resolve("detail", event, payload);
      updateAttempt(index, event, payload, "failed");
      addPolicy(event, payload);
    } else if (event.type === "search_funnel") {
      const parsed = parseFunnel(payload);
      if (parsed) funnel = parsed;
    } else if (event.type === "search_state_inspected") {
      const snapshotCounts = parseCounts(payload);
      mergeCounts(counts, snapshotCounts);
      const snapshotTermination = parseTermination(record(payload?.termination));
      const snapshot: RunTrajectoryStateSnapshot = {
        sequence: eventSequence(event, states.length),
        timestamp: eventTimestamp(event),
        counts: snapshotCounts,
        coverage: parseCoverage(payload?.coverage),
        sourceCoverage: parseSourceCoverage(payload?.sourceCoverage),
        coverageSufficient: bool(payload?.coverageSufficient),
        marginalUtility: parseMarginalUtility(payload?.marginalUtility),
        remaining: parseBudget(payload?.remaining),
        termination: snapshotTermination,
        unresolvedGoalCount: snapshotTermination?.unresolvedGoalCount ?? payloadCount(payload, "unresolvedGoalCount"),
        ...parseStateAdaptive(payload),
      };
      if (states.length < MAX_STATES) states.push(snapshot);
      mergeStateSourceStats(sources, payload?.sourceStats);
      mergeStatePaths(sources, payload?.paths);
    } else if (event.type === "search_finished") {
      const termination = parseTermination(payload);
      if (termination) searchTermination = termination;
      const terminalCounts = parseCounts(payload);
      mergeCounts(counts, terminalCounts);
      mergeStateSourceStats(sources, payload?.sourceStats);
      mergeStatePaths(sources, payload?.paths);
      const terminalSnapshot: RunTrajectoryStateSnapshot = {
        sequence: eventSequence(event, states.length),
        timestamp: eventTimestamp(event),
        counts: terminalCounts,
        coverage: parseCoverage(payload?.coverage),
        sourceCoverage: parseSourceCoverage(payload?.sourceCoverage),
        coverageSufficient: bool(payload?.coverageSufficient),
        marginalUtility: parseMarginalUtility(payload?.marginalUtility),
        remaining: parseBudget(payload?.remaining),
        termination,
        unresolvedGoalCount: termination?.unresolvedGoalCount ?? payloadCount(payload, "unresolvedGoalCount"),
        ...parseStateAdaptive(payload),
      };
      if (
        terminalSnapshot.remaining !== null ||
        terminalSnapshot.coverage !== null ||
        terminalSnapshot.sourceCoverage !== null ||
        terminalSnapshot.coverageSufficient !== null ||
        terminalSnapshot.marginalUtility !== null ||
        terminalSnapshot.termination !== null ||
        terminalSnapshot.unresolvedGoalCount !== null ||
        terminalSnapshot.counts.discovered !== null ||
        terminalSnapshot.counts.unique !== null ||
        terminalSnapshot.counts.enriched !== null ||
        terminalSnapshot.nextSearch !== undefined ||
        terminalSnapshot.plannerStop !== undefined ||
        terminalSnapshot.queryHistory !== undefined ||
        terminalSnapshot.paths !== undefined
      ) {
        if (states.length < MAX_STATES) states.push(terminalSnapshot);
        else states[states.length - 1] = terminalSnapshot;
      }
    } else if (event.type === "search_budget_rejected" || event.type === "detail_provenance_rejected" || event.type.endsWith("_source_rejected") || event.type === "search_rejected" || event.type === "detail_rejected") {
      const inferred = operationValue ?? (event.type.startsWith("detail") ? "detail" : "search");
      const index = resolve(inferred, event, payload);
      updateAttempt(index, event, payload, "rejected");
      addPolicy(event, payload);
    } else {
      addPolicy(event, payload);
    }
  }

  const usage = aggregateUsage(ordered);
  const resources: RunTrajectoryResources = {
    durationMs: runDuration(run),
    inputTokens: run.input_tokens ?? usage.inputTokens,
    outputTokens: run.output_tokens ?? usage.outputTokens,
    totalTokens: run.total_tokens ?? usage.totalTokens,
    estimatedCost: run.estimated_cost ?? usage.estimatedCost,
  };
  const runTermination = terminalTermination(run, ordered);
  const termination = run.status === "succeeded"
    ? searchTermination ?? runTermination
    : runTermination ?? searchTermination;
  const sourceOutputMap: Record<string, RunTrajectorySourceStats> = {};
  for (const [source, value] of [...sources.entries()].slice(0, MAX_SOURCES)) sourceOutputMap[source] = sourceOutput(value);
  return {
    counts,
    resources,
    configuredBudget,
    attempts,
    sourceStats: sourceOutputMap,
    states,
    adaptations: deriveAdaptations(attempts),
    termination,
    policyEvents,
    ...(funnel ? { funnel } : {}),
  };
}
