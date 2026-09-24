import { z } from "zod";
import { defineAgentTool, type AgentToolDefinition } from "../tools.js";
import { createScrapeTools, type ScrapeTools, type ScrapeToolsOptions } from "../scrape.js";
import { defaultCriteria } from "../config.js";
import type { CustomJobSource, JobSource, SearchBudget, SearchGoal, SearchHit, SearchPageInfo, TrajectoryRecorder } from "../../shared.js";
import type { SourceRegistry } from "../source-plugins.js";
import { AgentSearchState, resolveSearchBudget, type DetailReservation, type SearchAttempt } from "./state.js";

type SourceTools = ScrapeTools;
export type AgentSearchSourceTools = ReadonlyMap<JobSource, SourceTools> | Readonly<Record<string, SourceTools>>;

export type AgentSearchSource = {
  key: JobSource;
  custom?: CustomJobSource;
  registry?: SourceRegistry;
  maxAgeDays?: number;
  fallbackQueries?: string[];
  querySeeds?: readonly string[];
};

export type AgentSearchToolsOptions = {
  sources: readonly AgentSearchSource[];
  goal?: SearchGoal;
  budget?: Partial<SearchBudget> | SearchBudget;
  maxJobs?: number;
  runId?: string;
  trajectory?: TrajectoryRecorder;
  createSourceTools?: (options: ScrapeToolsOptions) => SourceTools;
  onSearchAttempt?: (attempt: SearchAttempt) => void;
  adaptive?: boolean;
};

export type AgentSearchToolOptions = {
  state: AgentSearchState;
  sourceTools: AgentSearchSourceTools;
};

export type AgentSearchTools = {
  searchJobs: AgentToolDefinition;
  fetchJobDetails: AgentToolDefinition;
  inspectSearchState: AgentToolDefinition;
  finishSearch: AgentToolDefinition;
  readonly allTools: AgentToolDefinition[];
  readonly state: AgentSearchState;
  readonly provenance: Map<string, string>;
  readonly detailDescriptions: Map<string, string>;
  readonly warnings: string[];
  readonly errors: string[];
};

const InspectInputSchema = z.object({}).strict();

const SearchInputSchema = z.object({
  source: z.string().trim().min(2).max(40).optional(),
  query: z.string().trim().min(1).max(200),
  location: z.string().trim().max(120).default(""),
  limit: z.number().int().min(1).max(25).default(25),
  page: z.number().int().min(1).optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
  intent: z.string().trim().max(200).optional(),
}).strict();
const DetailInputSchema = z.object({
  source: z.string().trim().min(2).max(40).optional(),
  resultId: z.string().trim().min(1).max(200),
}).strict();
const FinishInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  unresolvedGoals: z.array(z.string().trim().min(1).max(240)).max(20).default([]),
  reasonCategory: z.enum(["coverage_sufficient", "marginal_utility_low", "candidates_sufficient", "budget_exhausted", "no_results", "other"]).optional(),
}).strict();
const SearchEnvelopeSchema = z.object({
  results: z.array(z.object({
    id: z.string().trim().min(1).max(200).refine((value) => !/[\\/\0\r\n]/.test(value) && !value.startsWith("-"), "invalid result ID"),
    title: z.string().trim().min(1).max(500),
    url: z.string().url(),
    company: z.string().trim().nullable().optional(),
    location: z.string().trim().nullable().optional(),
  }).passthrough()),
  pageInfo: z.object({
    hasMore: z.boolean(),
    nextPage: z.number().int().min(1).optional(),
    nextCursor: z.string().trim().max(500).nullable().optional(),
    total: z.number().int().nonnegative().optional(),
    page: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }).optional(),
}).passthrough();
const DetailEnvelopeSchema = z.object({
  id: z.string().trim().min(1).max(200).nullable().optional(),
  title: z.string().trim().min(1).max(500).nullable().optional(),
  url: z.string().url().nullable().optional(),
  description: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  posting: z.string().nullable().optional(),
  company: z.string().trim().nullable().optional(),
  location: z.string().trim().nullable().optional(),
}).passthrough();

function sourceEntries(value: AgentSearchSourceTools) {
  return value instanceof Map ? [...value.entries()] : Object.entries(value) as Array<[JobSource, SourceTools]>;
}

function sourceMap(value: AgentSearchSourceTools) {
  return new Map(sourceEntries(value));
}

function textResult(value: unknown, label: string): unknown {
  const content = (value as { content?: unknown })?.content;
  if (!Array.isArray(content)) throw new Error(`${label} returned no content`);
  const block = content.find((item): item is { type: "text"; text: string } => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string");
  if (!block) throw new Error(`${label} returned no text`);
  try { return JSON.parse(block.text) as unknown; }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

function optionalText(value: string | null | undefined) {
  return value?.trim() || undefined;
}

function postedAt(value: Record<string, unknown>) {
  for (const key of ["postedAt", "postedDate", "posted_at", "date", "createdAt", "created_at"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function normalizedPageInfo(value: { hasMore: boolean; nextPage?: number; nextCursor?: string | null; total?: number; page?: number; limit?: number } | undefined): SearchPageInfo | undefined {
  if (!value) return undefined;
  const nextCursor = typeof value.nextCursor === "string" && value.nextCursor.trim() ? value.nextCursor.trim() : undefined;
  return {
    hasMore: value.hasMore,
    ...(value.nextPage === undefined ? {} : { nextPage: value.nextPage }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(value.total === undefined ? {} : { total: value.total }),
    ...(value.page === undefined ? {} : { page: value.page }),
    ...(value.limit === undefined ? {} : { limit: value.limit }),
  };
}
function toSearchHits(source: JobSource, value: unknown): { hits: SearchHit[]; pageInfo?: SearchPageInfo } {
  const parsed = SearchEnvelopeSchema.parse(value);
  return {
    hits: parsed.results.map((result) => ({
      source,
      sourceId: result.id,
      url: result.url,
      title: result.title,
      ...(optionalText(result.company) ? { company: optionalText(result.company) } : {}),
      ...(optionalText(result.location) ? { location: optionalText(result.location) } : {}),
      ...(postedAt(result) ? { postedAt: postedAt(result) } : {}),
    })),
    pageInfo: normalizedPageInfo(parsed.pageInfo),
  };
}

function reservationDetail(state: AgentSearchState, reservation: DetailReservation, posting: string, title?: string | null, company?: string | null, location?: string | null, url?: string | null) {
  state.completeDetail(reservation, posting);
  return {
    source: reservation.source,
    sourceId: reservation.sourceId,
    url: url || reservation.hit.url,
    title: title || reservation.hit.title,
    ...(company || reservation.hit.company ? { company: company || reservation.hit.company } : {}),
    ...(location || reservation.hit.location ? { location: location || reservation.hit.location } : {}),
    posting,
    description: posting,
  };
}

function toolsFromOptions(options: AgentSearchToolsOptions) {
  if (!Array.isArray(options.sources) || !options.sources.length) throw new Error("At least one search source is required.");
  const keys = options.sources.map((source) => source.key);
  if (new Set(keys).size !== keys.length) throw new Error("Search sources must be unique.");
  const goal = options.goal ?? { criteria: defaultCriteria, enabledSources: [...keys] };
  const enabled = new Set(goal.enabledSources);
  for (const key of keys) if (!enabled.has(key)) throw new Error(`Search source ${key} is not enabled by the search goal.`);
  for (const key of goal.enabledSources) if (!keys.includes(key)) throw new Error(`No source adapter is configured for ${key}.`);
  const makeSourceTools = options.createSourceTools ?? createScrapeTools;
  const budget = resolveSearchBudget(options.budget ?? {}, options.maxJobs ?? goal.criteria.maxJobsPerRun, goal.enabledSources.length);
  const sourceTools = new Map<JobSource, SourceTools>();
  const querySeeds = new Map<JobSource, readonly string[]>();
  const sourceCapabilities = new Map<JobSource, boolean>();
  for (const source of options.sources) {
    sourceTools.set(source.key, makeSourceTools({
      source: source.key,
      customSource: source.custom,
      registry: source.registry,
      maxAgeDays: source.maxAgeDays,
      maxSearchCalls: budget.maxSearchesPerSource,
      fallbackQueries: undefined,
    }));
    querySeeds.set(source.key, source.querySeeds ?? source.fallbackQueries ?? []);
    sourceCapabilities.set(source.key, sourceTools.get(source.key)?.manifest?.capabilities?.pagination === true);
  }
  const state = new AgentSearchState({
    goal,
    budget,
    runId: options.runId,
    trajectory: options.trajectory,
    onSearchAttempt: options.onSearchAttempt,
    adaptive: options.adaptive !== false,
    querySeeds,
    sourceCapabilities,
  });
  return { state, sourceTools };
}

export function createAgentSearchTools(options: AgentSearchToolsOptions): AgentSearchTools;
export function createAgentSearchTools(options: AgentSearchToolOptions): AgentSearchTools;
export function createAgentSearchTools(state: AgentSearchState, sourceTools: AgentSearchSourceTools): AgentSearchTools;
export function createAgentSearchTools(first: AgentSearchToolsOptions | AgentSearchToolOptions | AgentSearchState, second?: AgentSearchSourceTools): AgentSearchTools {
  const { state, sourceTools } = first instanceof AgentSearchState
    ? { state: first, sourceTools: second! }
    : "state" in first
      ? first
      : toolsFromOptions(first);
  const sourceManifests = sourceEntries(sourceTools).map(([, tools]) => tools.manifest);
  const toolsBySource = sourceMap(sourceTools);

  const searchJobs = defineAgentTool({
    name: "searchJobs",
    label: "Search enabled job sources",
    description: "Run one bounded discovery search on an enabled source. Returns discovery-only job hits without posting text.",
    schema: SearchInputSchema.shape,
    execute: async (toolCallId, rawParams, signal) => {
      const input = SearchInputSchema.parse(rawParams);
      const source = state.resolveSource(input.source, "search");
      const sourceTools = toolsBySource.get(source);
      if (!sourceTools) throw new Error(`No search adapter is configured for ${source}.`);
      const reservation = state.reserveSearch({ ...input, source });
      let completed = false;
      try {
        const raw = await sourceTools.searchJobs.execute(toolCallId, {
          query: reservation.query,
          location: reservation.location,
          limit: reservation.limit,
          ...(reservation.page === undefined ? {} : { page: reservation.page }),
          ...(reservation.cursor === undefined ? {} : { cursor: reservation.cursor }),
        }, signal);
        const parsed = toSearchHits(source, textResult(raw, "searchJobs"));
        const uniqueHits = state.completeSearch(reservation, parsed.hits.slice(0, reservation.limit), parsed.pageInfo);
        state.addWarnings(sourceTools.warnings ?? []);
        completed = true;
        return { content: [{ type: "text", text: JSON.stringify({ hits: uniqueHits, pageInfo: parsed.pageInfo ?? { hasMore: false } }) }], details: { source, count: uniqueHits.length } };
      } catch (error) {
        state.addWarnings(sourceTools.warnings ?? []);
        if (!completed) state.failSearch(reservation, error);
        throw error;
      }
    },
  });

  const fetchJobDetails = defineAgentTool({
    name: "fetchJobDetails",
    label: "Fetch selected job details",
    description: "Fetch full posting details only for an ID or URL returned by searchJobs in this run.",
    schema: DetailInputSchema.shape,
    execute: async (toolCallId, rawParams, signal) => {
      const input = DetailInputSchema.parse(rawParams);
      const source = state.resolveSource(input.source, "detail");
      const sourceTools = toolsBySource.get(source);
      if (!sourceTools) throw new Error(`No detail adapter is configured for ${source}.`);
      const reservation = state.reserveDetail({ source, resultId: input.resultId });
      let completed = false;
      try {
        const raw = await sourceTools.fetchJobDetails.execute(toolCallId, { resultId: reservation.resultId }, signal);
        const parsed = DetailEnvelopeSchema.parse(textResult(raw, "fetchJobDetails"));
        if (parsed.id && parsed.id !== reservation.sourceId) throw new Error(`${source} detail provenance mismatch`);
        const posting = parsed.posting ?? parsed.description ?? parsed.text;
        if (typeof posting !== "string" || !posting.trim()) throw new Error("fetchJobDetails returned no posting text");
        const detail = reservationDetail(state, reservation, posting, parsed.title, parsed.company, parsed.location, parsed.url);
        state.addWarnings(sourceTools.warnings ?? []);
        completed = true;
        return { content: [{ type: "text", text: JSON.stringify(detail) }], details: { source, sourceId: reservation.sourceId, cached: false } };
      } catch (error) {
        state.addWarnings(sourceTools.warnings ?? []);
        if (!completed) state.failDetail(reservation, error);
        throw error;
      }
    },
  });

  const inspectSearchState = defineAgentTool({
    name: "inspectSearchState",
    label: "Inspect search state",
    description: "Inspect bounded search progress, discovery hits, source statistics, enriched IDs, and remaining budgets.",
    schema: InspectInputSchema.shape,
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ ...state.inspect(), sources: sourceManifests }) }], details: { finished: Boolean(state.termination) } }),
  });

  const finishSearch = defineAgentTool({
    name: "finishSearch",
    label: "Finish job search",
    description: "Finish the search with a reason, optional category, and optional unresolved goals. This is required before returning final scored JSON.",
    schema: FinishInputSchema.shape,
    execute: async (_toolCallId, rawParams) => {
      const input = FinishInputSchema.parse(rawParams);
      const termination = state.finish(input.reason, input.unresolvedGoals, input.reasonCategory);
      return { content: [{ type: "text", text: JSON.stringify({ finished: true, reason: termination?.reason, reasonCategory: termination?.reasonCategory, unresolvedGoals: termination?.unresolvedGoals, termination, state: state.snapshot() }) }], details: { finished: true } };
    },
  });

  const allTools = [searchJobs, fetchJobDetails, inspectSearchState, finishSearch] as AgentToolDefinition[];
  const tools = { searchJobs, fetchJobDetails, inspectSearchState, finishSearch };
  Object.defineProperties(tools, {
    allTools: { value: allTools, enumerable: false },
    state: { value: state, enumerable: false },
    provenance: { value: state.provenance, enumerable: false },
    detailDescriptions: { value: state.detailDescriptions, enumerable: false },
    warnings: { get: () => state.warnings, enumerable: false },
    errors: { get: () => state.errors, enumerable: false },
  });
  return tools as unknown as AgentSearchTools;
}

export const createSearchTools = createAgentSearchTools;
