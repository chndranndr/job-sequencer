import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { z } from "zod";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { normalizeUrl } from "./db.js";
import { createCustomSourceAdapter, type CustomSourceFetch, validateCustomSourceDefinition } from "./custom-source.js";
import { isJobSource, jobSourceLabel, type BuiltInJobSource, type CustomJobSource, type JobSource } from "../shared.js";

function searchArgs(source: JobSource) {
  return Type.Object({
    query: Type.String({ minLength: 1, maxLength: 200 }),
    location: Type.String({ minLength: source === "linkedin" ? 1 : 0, maxLength: 120 }),
    limit: Type.Integer({ minimum: 1, maximum: 5 }),
  });
}
const DetailArgs = Type.Object({ resultId: Type.String({ minLength: 1, maxLength: 200 }) });

const SearchJobSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  url: z.string().url(),
}).passthrough();
const SearchResultSchema = z.object({
  meta: z.object({ count: z.number().int().nonnegative() }).passthrough(),
  results: z.array(SearchJobSchema),
});
const JapanSearchResultSchema = z.object({ count: z.number().int().nonnegative(), results: z.array(SearchJobSchema) }).passthrough();
const DetailSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  url: z.string().url(),
  description: z.string().nullable(),
}).passthrough();
export const ScrapeResultSchema = z.object({
  jobs: z.array(z.object({
    sourceId: z.string().min(1), source: z.string().min(1), url: z.string().url(),
    company: z.string(), role: z.string(), location: z.string(), posting: z.string(),
    score: z.number().int().min(0).max(100), reason: z.string(),
    strengths: z.array(z.string()), gaps: z.array(z.string()),
  })),
});
export type ScrapeResult = z.infer<typeof ScrapeResultSchema>;

const sourceCliDirectories: Record<BuiltInJobSource, string> = {
  freehire: "freehire-search",
  linkedin: "linkedin-search",
  tokyodev: "japan-boards-search",
  "japan-dev": "japan-boards-search",
};

function sourceFrom(value: unknown): JobSource {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(value)) throw new Error(`Unsupported job source: ${String(value)}`);
  return value;
}

function builtInSourceFrom(value: unknown): BuiltInJobSource {
  if (!isJobSource(value)) throw new Error(`Unsupported built-in job source: ${String(value)}`);
  return value;
}

function vendorCli(source: JobSource) {
  return resolve(process.cwd(), "vendor", "ai-job-search-skills", sourceCliDirectories[builtInSourceFrom(source)], "cli", "src", "cli.ts");
}

function vendorCliCwd(source: JobSource) {
  return resolve(process.cwd(), "vendor", "ai-job-search-skills", sourceCliDirectories[builtInSourceFrom(source)], "cli");
}

function safeArgument(value: string, label: string, allowEmpty = false) {
  const parsedResult = z.string().trim().max(label === "query" ? 200 : label === "location" ? 120 : 200).safeParse(value);
  if (!parsedResult.success) throw new Error(`${label} is too long or invalid`);
  const parsed = parsedResult.data;
  if (!allowEmpty && !parsed) throw new Error(`${label} must not be empty`);
  if (/^[\-]|[\0\r\n]|(?:^|\s)--?[A-Za-z]/.test(parsed)) throw new Error(`${label} contains an invalid command argument`);
  return parsed;
}

export type CliRunnerOptions = { signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number; source?: JobSource };
export type CliRunner = (args: string[], options?: CliRunnerOptions) => Promise<{ stdout: string; stderr: string; code: number }>;

export const runBunCli: CliRunner = async (args, options = {}) => {
  const source = builtInSourceFrom(options.source ?? "freehire");
  const child = spawn("bun", ["run", vendorCli(source), ...args], {
    cwd: vendorCliCwd(source),
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 30_000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const onAbort = () => child.kill();
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const [result] = await once(child, "close") as [number | null];
    if (timedOut) throw new Error(`${jobSourceLabel(source)} CLI timed out`);
    return { stdout, stderr, code: result ?? 1 };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
};

function normalizeSearchResult(source: JobSource, value: unknown) {
  if (source === "tokyodev" || source === "japan-dev") {
    const parsed = JapanSearchResultSchema.parse(value);
    return { meta: { count: parsed.count }, results: parsed.results };
  }
  return SearchResultSchema.parse(value);
}

function normalizeDetail(source: JobSource, value: unknown, sourceId: string) {
  if (source === "tokyodev" || source === "japan-dev") {
    const parsed = z.object({ url: z.string().url(), title: z.string(), text: z.string() }).passthrough().parse(value);
    return { id: sourceId, title: parsed.title, url: parsed.url, description: parsed.text };
  }
  const parsed = DetailSchema.parse(value);
  if (parsed.id !== sourceId) throw new Error(`${jobSourceLabel(source)} detail provenance mismatch`);
  return parsed;
}

function recordDetailDescription(target: Map<string, string>, sourceId: string, description: unknown) {
  if (typeof description === "string" && description.trim()) target.set(sourceId, description);
}

function linkedinUrlId(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return undefined;
    if (url.hostname !== "linkedin.com" && url.hostname !== "www.linkedin.com" && !/^[a-z]{2}\.linkedin\.com$/.test(url.hostname)) return undefined;
    return url.pathname.match(/^\/jobs\/view\/(?:[^/]+-)?(\d{6,})\/?$/)?.[1];
  } catch {
    return undefined;
  }
}

function detailUrlMatches(source: JobSource, expectedUrl: string, actualUrl: string, sourceId: string) {
  if (source !== "linkedin") return expectedUrl === actualUrl;
  if (!/^\d{6,}$/.test(sourceId)) return false;
  return linkedinUrlId(expectedUrl) === sourceId && linkedinUrlId(actualUrl) === sourceId;
}

const staleFreshnessDays = 45;
const staleWarning = (label: string) => `${label} returned results older than ${staleFreshnessDays} days; verify that postings are still active.`;
const maxSearchCalls = 5;
const maxFallbackQueries = 5;

export function sanitizeFallbackQueries(values: readonly string[] | undefined): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const candidate = value.replace(/\s+/g, " ").trim();
    if (!candidate || candidate.length > 120) continue;
    let query: string;
    try { query = safeArgument(candidate, "query"); }
    catch { continue; }
    if (seen.has(query)) continue;
    seen.add(query);
    queries.push(query);
    if (queries.length >= maxFallbackQueries) break;
  }
  return queries;
}

function dedupeSearchResults(results: readonly { id: string; url: string }[]) {
  const ids = new Set<string>();
  const urls = new Set<string>();
  return results.filter((job) => {
    const url = normalizeUrl(job.url);
    if (ids.has(job.id) || urls.has(url)) return false;
    ids.add(job.id);
    urls.add(url);
    return true;
  });
}

function postedTimestamp(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of ["postedDate", "posted_at", "postedAt", "date", "created_at", "createdAt"]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate !== "string") continue;
    const timestamp = Date.parse(candidate);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return undefined;
}

export function createScrapeTools(options: { source?: JobSource; customSource?: CustomJobSource; runCli?: CliRunner; env?: NodeJS.ProcessEnv; fetcher?: CustomSourceFetch; maxAgeDays?: number; now?: () => number; fallbackQueries?: string[] } = {}) {
  const source = sourceFrom(options.source ?? "freehire");
  const maxAgeDays = options.maxAgeDays === undefined ? undefined : z.number().int().min(1).max(9999).parse(options.maxAgeDays);
  const now = options.now ?? Date.now;
  const customSource = source === "freehire" || source === "linkedin" || source === "tokyodev" || source === "japan-dev"
    ? undefined
    : validateCustomSourceDefinition(options.customSource && options.customSource.key === source ? options.customSource : (() => { throw new Error(`Custom source ${source} is not configured.`); })());
  const label = jobSourceLabel(source, customSource ? [customSource] : []);
  const runCli = options.runCli ?? ((args: string[], cliOptions?: CliRunnerOptions) => runBunCli(args, { ...(cliOptions ?? {}), source }));
  const customAdapter = customSource ? createCustomSourceAdapter(customSource, { fetcher: options.fetcher }) : undefined;
  const returned = new Map<string, string>();
  const detailDescriptions = new Map<string, string>();
  const warnings: string[] = [];
  let searchCalls = 0;
  const fallbackQueries = source === "tokyodev" || source === "japan-dev" ? sanitizeFallbackQueries(options.fallbackQueries) : [];

  function noteStaleResults(results: readonly unknown[]) {
    if (maxAgeDays === undefined || maxAgeDays <= staleFreshnessDays) return;
    const cutoff = now() - staleFreshnessDays * 24 * 60 * 60 * 1000;
    if (results.some((result) => { const timestamp = postedTimestamp(result); return timestamp !== undefined && timestamp < cutoff; }) && !warnings.includes(staleWarning(label))) warnings.push(staleWarning(label));
  }

  const searchJobs = defineTool({
    name: "searchJobs",
    label: `Search ${label} jobs`,
    description: source === "linkedin"
      ? `Search the vendored ${label} source. A non-empty location is required; returns no more than five jobs.`
      : `Search the vendored ${label} source. Returns no more than five jobs.`,
    parameters: searchArgs(source),
    execute: async (_id, params, signal) => {
      searchCalls += 1;
      if (searchCalls > maxSearchCalls) throw new Error("searchJobs may be called at most five times per run");
      const query = safeArgument(params.query, "query");
      const location = safeArgument(params.location, "location", true);
      const limit = z.number().int().min(1).max(5).parse(params.limit);
      if (customAdapter) {
        const parsed = await customAdapter.search(query, location, limit, signal);
        for (const job of parsed.results) returned.set(job.id, job.url);
        return { content: [{ type: "text", text: JSON.stringify(parsed) }], details: { count: parsed.results.length } };
      }
      if (source === "linkedin" && !location) throw new Error("LinkedIn search requires a location");
      async function runSearch(searchQuery: string, fallback = false) {
        if (fallback) {
          searchCalls += 1;
          if (searchCalls > maxSearchCalls) throw new Error("searchJobs may be called at most five times per run");
        }
        const args = source === "linkedin"
          ? ["search", "--location", location, "--query", searchQuery, "--limit", String(limit), "--format", "json"]
          : source === "tokyodev" || source === "japan-dev"
            ? ["search", "--source", source, "--query", searchQuery, "--country", "Japan", "--limit", String(limit), "--format", "json"]
            : ["search", "--query", searchQuery, "--limit", String(limit), "--format", "json"];
        if (source === "freehire" && location) args.push("--city", location);
        if (maxAgeDays !== undefined) args.push("--jobage", String(maxAgeDays));
        const result = await runCli(args, { signal, env: options.env });
        if (result.code !== 0) throw new Error(`${label} search failed: ${result.stderr.trim() || result.code}`);
        const parsed = normalizeSearchResult(source, JSON.parse(result.stdout));
        noteStaleResults(parsed.results);
        for (const job of parsed.results) if (!returned.has(job.id)) returned.set(job.id, job.url);
        return parsed;
      }

      const initial = await runSearch(query);
      if (source !== "tokyodev" && source !== "japan-dev") return { content: [{ type: "text", text: JSON.stringify(initial) }], details: { count: initial.results.length } };
      let results = dedupeSearchResults(initial.results);
      if (!results.length && fallbackQueries.length) {
        for (const fallbackQuery of fallbackQueries) {
          if (searchCalls >= maxSearchCalls) break;
          if (fallbackQuery === query) continue;
          const fallback = await runSearch(fallbackQuery, true);
          results = dedupeSearchResults([...results, ...fallback.results]);
          if (results.length) break;
        }
      }
      const capped = results.slice(0, limit);
      const parsed = { meta: { count: capped.length }, results: capped };
      return { content: [{ type: "text", text: JSON.stringify(parsed) }], details: { count: capped.length } };
    },
  });

  const fetchJobDetails = defineTool({
    name: "fetchJobDetails",
    label: `Fetch ${label} job details`,
    description: `Fetch details only for a result ID or URL returned by searchJobs for ${label} in this run.`,
    parameters: DetailArgs,
    execute: async (_id, params, signal) => {
      const resultId = safeArgument(params.resultId, "resultId").replace(/\\/g, "/");
      if (source === "freehire" && resultId.includes("/")) throw new Error("resultId contains an invalid command argument");
      const directUrl = returned.get(resultId);
      const normalizedResultId = directUrl ? undefined : (() => { try { return normalizeUrl(resultId); } catch { return resultId; } })();
      const urlEntry = directUrl ? undefined : [...returned.entries()].find(([, url]) => url === resultId || url === normalizedResultId);
      const returnedEntry = directUrl
        ? { sourceId: resultId, url: directUrl }
        : urlEntry ? { sourceId: urlEntry[0], url: urlEntry[1] } : undefined;
      if (!returnedEntry) throw new Error(`resultId ${resultId} was not returned by searchJobs in this run`);
      if (customAdapter) {
        const detail = await customAdapter.detail(returnedEntry.sourceId, returnedEntry.url, signal);
        recordDetailDescription(detailDescriptions, returnedEntry.sourceId, detail.description);
        return { content: [{ type: "text", text: JSON.stringify(detail) }], details: { resultId } };
      }
      const detailArg = source === "tokyodev" || source === "japan-dev" ? returnedEntry.url : resultId;
      const result = await runCli(["detail", detailArg, "--format", "json"], { signal, env: options.env });
      if (result.code !== 0) throw new Error(`${label} detail failed: ${result.stderr.trim() || result.code}`);
      const detail = normalizeDetail(source, JSON.parse(result.stdout), returnedEntry.sourceId);
      if (!detailUrlMatches(source, returnedEntry.url, detail.url, returnedEntry.sourceId)) throw new Error(`${label} detail provenance mismatch`);
      recordDetailDescription(detailDescriptions, returnedEntry.sourceId, detail.description);
      return { content: [{ type: "text", text: JSON.stringify(detail) }], details: { resultId } };
    },
  });

  const tools = { searchJobs, fetchJobDetails };
  Object.defineProperty(tools, "provenance", { value: returned, enumerable: false });
  Object.defineProperty(tools, "detailDescriptions", { value: detailDescriptions, enumerable: false });
  Object.defineProperty(tools, "warnings", { value: warnings, enumerable: false });
  return tools as typeof tools & { provenance: Map<string,string>; detailDescriptions: Map<string,string>; warnings: string[] };
}

export function hydrateScrapeResult(result: ScrapeResult, detailDescriptions: ReadonlyMap<string, string>): ScrapeResult {
  return { jobs: result.jobs.map((job) => {
    const description = detailDescriptions.get(provenanceKey(job.source, job.sourceId)) ?? detailDescriptions.get(job.sourceId);
    return description?.trim() ? { ...job, posting: description } : job;
  }) };
}

export function provenanceKey(source: string, sourceId: string) { return `${source}\u0000${sourceId}`; }

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
