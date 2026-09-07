import { z } from "zod";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { normalizeUrl } from "./db.js";
import {
  createSourceRegistry,
  defaultSourceRegistry,
  dedupeSearchResults,
  MAX_SOURCE_SEARCH_CALLS,
  runBunCli,
  SourcePolicyLedger,
  sourceDetailUrlMatches,
  sourcePostedTimestamp,
  sourceUrlSchema,
  validateSourcePlugin,
  type CliRunner,
  type CustomSourceFetch,
  type SourcePolicySnapshot,
  type SourceSearchHit,
  type JobSourcePlugin,
  type SourceRegistry,
} from "./source-plugins.js";
import type { CustomJobSource, JobSource } from "../shared.js";

export type { CliRunner, CliRunnerOptions } from "./source-plugins.js";
export { runBunCli, sanitizeFallbackQueries } from "./source-plugins.js";

function sourceFrom(value: unknown): JobSource {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(value)) throw new Error(`Unsupported job source: ${String(value)}`);
  return value;
}

const SearchArgs = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200 }),
  location: Type.String({ maxLength: 120 }),
  limit: Type.Integer({ minimum: 1, maximum: 5 }),
});
const DetailArgs = Type.Object({ resultId: Type.String({ minLength: 1, maxLength: 200 }) });

const SearchResponseSchema = z.object({
  meta: z.object({ count: z.number().int().nonnegative() }).passthrough(),
  results: z.array(z.object({
    id: z.string().trim().min(1).max(200).refine(value => !/[\\/\0\r\n]/.test(value) && !value.startsWith("-"), "invalid result ID"),
    title: z.string().trim().min(1).max(500),
    url: sourceUrlSchema,
    company: z.string().nullable(),
    location: z.string().nullable(),
    postedAt: z.string().optional(),
  }).passthrough()),
}).passthrough();

export const ScrapeResultSchema = z.object({
  jobs: z.array(z.object({
    sourceId: z.string().min(1), source: z.string().min(1), url: sourceUrlSchema,
    company: z.string(), role: z.string(), location: z.string(), posting: z.string(),
    score: z.number().int().min(0).max(100), reason: z.string(),
    strengths: z.array(z.string()), gaps: z.array(z.string()),
  })),
});
export type ScrapeResult = z.infer<typeof ScrapeResultSchema>;

function safeArgument(value: string, label: string, allowEmpty = false) {
  const parsedResult = z.string().trim().max(label === "query" ? 200 : label === "location" ? 120 : 200).safeParse(value);
  if (!parsedResult.success) throw new Error(`${label} is too long or invalid`);
  const parsed = parsedResult.data;
  if (!allowEmpty && !parsed) throw new Error(`${label} must not be empty`);
  if (/^[\-]|[\0\r\n]|(?:^|\s)--?[A-Za-z]/.test(parsed)) throw new Error(`${label} contains an invalid command argument`);
  return parsed;
}

function recordDetailDescription(target: Map<string, string>, sourceId: string, description: unknown) {
  if (typeof description === "string" && description.trim()) target.set(sourceId, description);
}

export type ScrapeToolsOptions = {
  source?: JobSource;
  customSource?: CustomJobSource;
  plugin?: JobSourcePlugin;
  registry?: SourceRegistry;
  runCli?: CliRunner;
  env?: NodeJS.ProcessEnv;
  fetcher?: CustomSourceFetch;
  maxAgeDays?: number;
  now?: () => number;
  fallbackQueries?: string[];
};

export function createScrapeTools(options: ScrapeToolsOptions = {}) {
  const source = sourceFrom(options.source ?? "freehire");
  const registry = options.registry ?? defaultSourceRegistry;
  const plugin = validateSourcePlugin(options.plugin ?? registry.resolve(source, options.customSource?.key === source ? options.customSource : undefined));
  const runCli = options.runCli ?? runBunCli;
  if (plugin.manifest.id !== source) throw new Error(`Source plugin ${plugin.manifest.id} does not match ${source}.`);
  const maxAgeDays = options.maxAgeDays === undefined ? undefined : z.number().int().min(1).max(9_999).parse(options.maxAgeDays);
  const now = options.now ?? Date.now;
  const returned = new Map<string, string>();
  const detailDescriptions = new Map<string, string>();
  const warnings: string[] = [];
  const policy = new SourcePolicyLedger(plugin.manifest.label, plugin.manifest.policy);
  let searchCalls = 0;

  function recordSearchAttempt() {
    if (searchCalls >= MAX_SOURCE_SEARCH_CALLS) return false;
    searchCalls++;
    return true;
  }

  function context(signal: AbortSignal | undefined) {
    return {
      source,
      signal,
      env: options.env,
      fetcher: options.fetcher,
      runCli,
      now,
      request: <T>(operation: (requestSignal: AbortSignal) => Promise<T>) => policy.run(signal, operation),
      searchAttempt: recordSearchAttempt,
    };
  }

  function noteStaleResults(results: readonly SourceSearchHit[]) {
    if (maxAgeDays === undefined || maxAgeDays <= 45) return;
    const cutoff = now() - 45 * 24 * 60 * 60 * 1000;
    if (!results.some(result => {
      const timestamp = sourcePostedTimestamp(result);
      return timestamp !== undefined && timestamp < cutoff;
    })) return;
    const warning = `${plugin.manifest.label} returned results older than 45 days; verify that postings are still active.`;
    if (!warnings.includes(warning)) warnings.push(warning);
  }

  const searchJobs = defineTool({
    name: "searchJobs",
    label: `Search ${plugin.manifest.label} jobs`,
    description: `Search the configured ${plugin.manifest.label} source. Returns no more than five jobs.`,
    parameters: SearchArgs,
    execute: async (_id, params, signal) => {
      if (!recordSearchAttempt()) throw new Error("searchJobs may be called at most five times per run");
      const query = safeArgument(params.query, "query");
      const location = safeArgument(params.location, "location", true);
      const limit = z.number().int().min(1).max(5).parse(params.limit);
      const response = await plugin.search({ query, location, limit, maxAgeDays, fallbackQueries: options.fallbackQueries }, context(signal));
      const parsed = SearchResponseSchema.parse(response);
      const results = dedupeSearchResults(parsed.results as SourceSearchHit[]).slice(0, limit);
      noteStaleResults(results);
      for (const job of results) returned.set(job.id, job.url);
      const normalized = { meta: { count: results.length }, results };
      return { content: [{ type: "text", text: JSON.stringify(normalized) }], details: { count: results.length } };
    },
  });

  const fetchJobDetails = defineTool({
    name: "fetchJobDetails",
    label: `Fetch ${plugin.manifest.label} job details`,
    description: `Fetch details only for a result ID or URL returned by searchJobs for ${plugin.manifest.label} in this run.`,
    parameters: DetailArgs,
    execute: async (_id, params, signal) => {
      const resultId = safeArgument(params.resultId, "resultId").replace(/\\/g, "/");
      const directUrl = returned.get(resultId);
      let normalizedResultId = resultId;
      try { normalizedResultId = normalizeUrl(resultId); } catch { /* IDs are not URLs. */ }
      const urlEntry = directUrl ? undefined : [...returned.entries()].find(([, url]) => url === resultId || url === normalizedResultId);
      const returnedEntry = directUrl ? { sourceId: resultId, url: directUrl } : urlEntry ? { sourceId: urlEntry[0], url: urlEntry[1] } : undefined;
      if (!returnedEntry) throw new Error(`resultId ${resultId} was not returned by searchJobs in this run`);
      if (!plugin.details) throw new Error(`${plugin.manifest.label} does not support job details`);
      const detail = await plugin.details({ id: returnedEntry.sourceId, url: returnedEntry.url }, context(signal));
      const parsed = z.object({ id: z.string().min(1), title: z.string(), url: z.string().url(), description: z.string().nullable() }).passthrough().parse(detail);
      if (parsed.id !== returnedEntry.sourceId || !sourceDetailUrlMatches(plugin, returnedEntry.sourceId, returnedEntry.url, parsed.url)) throw new Error(`${plugin.manifest.label} detail provenance mismatch`);
      recordDetailDescription(detailDescriptions, returnedEntry.sourceId, parsed.description);
      return { content: [{ type: "text", text: JSON.stringify(parsed) }], details: { resultId } };
    },
  });

  const tools = { searchJobs, fetchJobDetails };
  Object.defineProperty(tools, "provenance", { value: returned, enumerable: false });
  Object.defineProperty(tools, "detailDescriptions", { value: detailDescriptions, enumerable: false });
  Object.defineProperty(tools, "warnings", { value: warnings, enumerable: false });
  Object.defineProperty(tools, "manifest", { value: plugin.manifest, enumerable: false });
  Object.defineProperty(tools, "policy", { get: () => policy.snapshot, enumerable: false });
  return tools as typeof tools & {
    provenance: Map<string, string>;
    detailDescriptions: Map<string, string>;
    warnings: string[];
    manifest: typeof plugin.manifest;
    policy: SourcePolicySnapshot;
  };
}

export function hydrateScrapeResult(result: ScrapeResult, detailDescriptions: ReadonlyMap<string, string>): ScrapeResult {
  return { jobs: result.jobs.map(job => {
    const description = detailDescriptions.get(provenanceKey(job.source, job.sourceId)) ?? detailDescriptions.get(job.sourceId);
    return description?.trim() ? { ...job, posting: description } : job;
  }) };
}

export function provenanceKey(source: string, sourceId: string) { return `${source}\u0000${sourceId}`; }

export function detailUrlMatches(source: string, expectedUrl: string, actualUrl: string, sourceId: string) {
  try {
    return sourceDetailUrlMatches(defaultSourceRegistry.resolve(source), sourceId, expectedUrl, actualUrl);
  } catch {
    return expectedUrl === actualUrl;
  }
}

export function validateScrapeResult(value: unknown, provenance: Map<string, string>, maxJobsPerRun = 50, expectedSource?: string, allowedSources?: readonly string[]) {
  const result = ScrapeResultSchema.parse(value);
  const limit = Math.min(maxJobsPerRun, 50);
  if (!Number.isInteger(maxJobsPerRun) || maxJobsPerRun < 1) throw new Error("maximum jobs per run must be a positive integer");
  if (result.jobs.length > limit) throw new Error(`Scrape result exceeds the maximum of ${limit} jobs`);
  const sourceIds = new Set<string>();
  const urls = new Set<string>();
  for (const job of result.jobs) {
    if (/[\\/\0\r\n]/.test(job.sourceId) || job.sourceId.startsWith("-")) throw new Error("job sourceId contains an invalid value");
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(job.source)) throw new Error(`job ${job.sourceId} has an invalid source key`);
    if (expectedSource && job.source !== expectedSource) throw new Error(`job ${job.sourceId} source must be ${expectedSource}`);
    if (allowedSources && !allowedSources.includes(job.source)) throw new Error(`job ${job.sourceId} source is not enabled`);
    const directProvenanceAllowed = !allowedSources || allowedSources.length === 1;
    const returnedUrl = provenance.get(provenanceKey(job.source, job.sourceId)) ?? (directProvenanceAllowed ? provenance.get(job.sourceId) : undefined);
    if (returnedUrl === undefined || !detailUrlMatches(job.source, returnedUrl, job.url, job.sourceId)) throw new Error(`job ${job.sourceId} was not returned by a tool with this URL`);
    const normalized = normalizeUrl(job.url);
    const sourceKey = provenanceKey(job.source, job.sourceId);
    if (sourceIds.has(sourceKey)) throw new Error(`duplicate source ID ${job.sourceId}`);
    if (urls.has(normalized)) throw new Error(`duplicate normalized URL ${normalized}`);
    sourceIds.add(sourceKey);
    urls.add(normalized);
  }
  return result;
}

export { createSourceRegistry };
