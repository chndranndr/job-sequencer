import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { z } from "zod";
import { normalizeUrl } from "./db.js";
import {
  createCustomSourceAdapter,
  CUSTOM_SOURCE_TIMEOUT_MS,
  type CustomSourceFetch,
  validateCustomSourceDefinition,
} from "./custom-source.js";
import type { CustomJobSource, JobSource } from "../shared.js";
export type { CustomSourceFetch } from "./custom-source.js";

export type SourceCapabilities = Readonly<{
  search: boolean;
  detail: boolean;
  pagination: boolean;
  location: boolean;
  freshness: boolean;
  remote: boolean;
  activeStatus: boolean;
}>;

export type SourcePolicy = Readonly<{
  maxRequestsPerRun: number;
  maxConcurrentRequests: number;
  timeoutMs: number;
  minimumDelayMs: number;
}>;

export type SourcePolicySnapshot = Readonly<{
  used: number;
  remaining: number;
  active: number;
}>;

export type SourceGuidance = Readonly<{
  strengths: readonly string[];
  caveats: readonly string[];
  query: string;
}>;

export type SourceManifest = Readonly<{
  id: JobSource;
  label: string;
  version: string;
  capabilities: SourceCapabilities;
  policy: SourcePolicy;
  guidance: SourceGuidance;
  defaults?: Readonly<{ maxAgeDays?: number }>;
  preflight?: boolean;
}>;

export type SourceSearchRequest = Readonly<{
  query: string;
  location: string;
  limit: number;
  maxAgeDays?: number;
  fallbackQueries?: readonly string[];
}>;

export type SourceSearchHit = Readonly<{
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  postedAt?: string;
}>;

export type SourceSearchResponse = Readonly<{
  meta: { count: number };
  results: SourceSearchHit[];
}>;

export type SourceDetail = Readonly<{
  id: string;
  title: string;
  url: string;
  description: string | null;
}>;

export type CliRunnerOptions = {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  source?: JobSource;
};

export type CliRunner = (args: string[], options?: CliRunnerOptions) => Promise<{
  stdout: string;
  stderr: string;
  code: number;
}>;

export type SourcePluginContext = Readonly<{
  source: JobSource;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  fetcher?: CustomSourceFetch;
  runCli?: CliRunner;
  now: () => number;
  request<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  searchAttempt(): boolean;
}>;

export type JobSourcePlugin = Readonly<{
  manifest: SourceManifest;
  search(request: SourceSearchRequest, context: SourcePluginContext): Promise<SourceSearchResponse>;
  details?(ref: { id: string; url: string }, context: SourcePluginContext): Promise<SourceDetail>;
  matchesDetailUrl?(sourceId: string, expectedUrl: string, actualUrl: string): boolean;
  fallbackQueries?(values: readonly string[]): string[];
}>;

const sourceKey = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const manifestSchema = z.object({
  id: sourceKey,
  label: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(32),
  capabilities: z.object({
    search: z.boolean(),
    detail: z.boolean(),
    pagination: z.boolean(),
    location: z.boolean(),
    freshness: z.boolean(),
    remote: z.boolean(),
    activeStatus: z.boolean(),
  }).strict(),
  policy: z.object({
    maxRequestsPerRun: z.number().int().min(1).max(100),
    maxConcurrentRequests: z.number().int().min(1).max(8),
    timeoutMs: z.number().int().min(1).max(120_000),
    minimumDelayMs: z.number().int().min(0).max(60_000),
  }).strict(),
  guidance: z.object({
    strengths: z.array(z.string().trim().min(1).max(240)).max(8),
    caveats: z.array(z.string().trim().min(1).max(240)).max(8),
    query: z.string().trim().min(1).max(1_000),
  }).strict(),
  defaults: z.object({ maxAgeDays: z.number().int().min(1).max(9_999).optional() }).strict().optional(),
  preflight: z.boolean().optional(),
}).strict();
export const sourceUrlSchema = z.string().url().refine(value => {
  const parsed = new URL(value);
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
}, "URL must use HTTP(S) without credentials");

function freezeManifest(value: SourceManifest): SourceManifest {
  const parsed = manifestSchema.parse(value) as SourceManifest;
  return Object.freeze({
    ...parsed,
    capabilities: Object.freeze({ ...parsed.capabilities }),
    policy: Object.freeze({ ...parsed.policy }),
    guidance: Object.freeze({
      ...parsed.guidance,
      strengths: Object.freeze([...parsed.guidance.strengths]),
      caveats: Object.freeze([...parsed.guidance.caveats]),
    }),
    defaults: parsed.defaults ? Object.freeze({ ...parsed.defaults }) : undefined,
  });
}

export function validateSourceManifest(value: unknown): SourceManifest {
  return freezeManifest(value as SourceManifest);
}

export function validateSourcePlugin(plugin: JobSourcePlugin): JobSourcePlugin {
  const manifest = validateSourceManifest(plugin.manifest);
  if (!manifest.capabilities.search) throw new Error(`Source plugin ${manifest.id} must declare search capability.`);
  if (typeof plugin.search !== "function") throw new Error(`Source plugin ${manifest.id} must implement search.`);
  if (manifest.capabilities.detail !== Boolean(plugin.details)) throw new Error(`Source plugin ${manifest.id} detail capability does not match implementation.`);
  return { ...plugin, manifest };
}

function manifest(value: Omit<SourceManifest, "capabilities" | "policy"> & {
  capabilities: SourceCapabilities;
  policy: SourcePolicy;
}): SourceManifest {
  return freezeManifest(value);
}

function abortReason(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function waitForDelay(delayMs: number, signal?: AbortSignal) {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolveDelay, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type Waiter = {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

export class SourcePolicyLedger {
  private requests = 0;
  private active = 0;
  private nextStartAt = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly label: string, private readonly policy: SourcePolicy) {}

  get remaining() {
    return Math.max(0, this.policy.maxRequestsPerRun - this.requests);
  }

  get snapshot(): SourcePolicySnapshot {
    return { used: this.requests, remaining: this.remaining, active: this.active };
  }


  private pump() {
    while (this.active < this.policy.maxConcurrentRequests && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.cleanup();
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.active++;
      waiter.cleanup();
      waiter.resolve(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<() => void>((resolvePermit, rejectPermit) => {
      let waiter: Waiter;
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.cleanup();
        rejectPermit(abortReason(signal));
      };
      waiter = {
        signal,
        resolve: resolvePermit,
        reject: rejectPermit,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  async run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.requests >= this.policy.maxRequestsPerRun) throw new Error(`${this.label} request budget exhausted`);
    this.requests++;
    const releasePermit = await this.acquire(signal);
    let releaseOnce: (() => void) | undefined = releasePermit;
    const releaseAfterSettle = () => {
      if (!releaseOnce) return;
      const release = releaseOnce;
      releaseOnce = undefined;
      release();
    };
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let operationPromise: Promise<T> | undefined;
    let rejectTimeout!: (reason?: unknown) => void;
    let rejectAbort!: (reason?: unknown) => void;
    const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const abortedPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      controller.abort(signal?.reason);
      rejectAbort(abortReason(signal));
    };
    timeoutPromise.catch(() => {});
    abortedPromise.catch(() => {});
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const now = Date.now();
      const startAt = Math.max(now, this.nextStartAt);
      this.nextStartAt = startAt + this.policy.minimumDelayMs;
      await waitForDelay(startAt - now, signal);
      timer = setTimeout(() => {
        timedOut = true;
        const error = new Error(`${this.label} request timed out`);
        controller.abort(error);
        rejectTimeout(error);
      }, this.policy.timeoutMs);
      const currentOperation = Promise.resolve(operation(controller.signal));
      operationPromise = currentOperation;
      currentOperation.finally(releaseAfterSettle).catch(() => {});
      return await Promise.race([currentOperation, timeoutPromise, abortedPromise]);
    } catch (error) {
      if (timedOut) throw new Error(`${this.label} request timed out`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!operationPromise) releaseAfterSettle();
    }
  }
}

const sourceCliDirectories: Record<string, string> = {
  freehire: "freehire-search",
  linkedin: "linkedin-search",
  tokyodev: "japan-boards-search",
  "japan-dev": "japan-boards-search",
};

function builtinSource(source: JobSource) {
  if (!sourceCliDirectories[source]) throw new Error(`Unsupported built-in job source: ${source}`);
  return source;
}

function vendorCli(source: JobSource) {
  return resolve(process.cwd(), "vendor", "ai-job-search-skills", sourceCliDirectories[builtinSource(source)], "cli", "src", "cli.ts");
}

function vendorCliCwd(source: JobSource) {
  return resolve(process.cwd(), "vendor", "ai-job-search-skills", sourceCliDirectories[builtinSource(source)], "cli");
}

export const runBunCli: CliRunner = async (args, options = {}) => {
  const source = builtinSource(options.source ?? "freehire");
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
    const [code] = await once(child, "close") as [number | null];
    if (timedOut) throw new Error(`${source} CLI timed out`);
    return { stdout, stderr, code: code ?? 1 };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
};

function safeArgument(value: string, label: string, allowEmpty = false) {
  const parsedResult = z.string().trim().max(label === "query" ? 200 : label === "location" ? 120 : 200).safeParse(value);
  if (!parsedResult.success) throw new Error(`${label} is too long or invalid`);
  const parsed = parsedResult.data;
  if (!allowEmpty && !parsed) throw new Error(`${label} must not be empty`);
  if (/^[\-]|[\0\r\n]|(?:^|\s)--?[A-Za-z]/.test(parsed)) throw new Error(`${label} contains an invalid command argument`);
  return parsed;
}

const searchJobSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  url: sourceUrlSchema,
  postedAt: z.string().optional(),
  postedDate: z.string().optional(),
  posted_at: z.string().optional(),
  date: z.string().optional(),
  createdAt: z.string().optional(),
  created_at: z.string().optional(),
}).passthrough();
const searchResultSchema = z.object({ meta: z.object({ count: z.number().int().nonnegative() }).passthrough(), results: z.array(searchJobSchema) });
const japanSearchResultSchema = z.object({ count: z.number().int().nonnegative(), results: z.array(searchJobSchema) }).passthrough();
const detailSchema = z.object({ id: z.string().min(1), title: z.string(), url: sourceUrlSchema, description: z.string().nullable() }).passthrough();
const japanDetailSchema = z.object({ url: sourceUrlSchema, title: z.string(), text: z.string() }).passthrough();

function toSearchResponse(results: z.infer<typeof searchJobSchema>[], count = results.length): SourceSearchResponse {
  return {
    meta: { count },
    results: results.map(result => ({
      ...result,
      id: result.id,
      title: result.title,
      company: result.company,
      location: result.location,
      url: result.url,
      ...(["postedAt", "postedDate", "posted_at", "date", "createdAt", "created_at"] as const).reduce<Record<string, string>>((fields, key) => {
        if (typeof result[key] === "string" && result[key]) fields[key] = result[key];
        return fields;
      }, {}),
    })),
  };
}

function parseDefaultSearch(value: unknown) {
  const parsed = searchResultSchema.parse(value);
  return toSearchResponse(parsed.results, parsed.meta.count);
}

function parseJapanSearch(value: unknown) {
  const parsed = japanSearchResultSchema.parse(value);
  return toSearchResponse(parsed.results, parsed.count);
}

function parseDefaultDetail(value: unknown, sourceId: string) {
  const parsed = detailSchema.parse(value);
  if (parsed.id !== sourceId) throw new Error("detail provenance mismatch");
  return parsed;
}

function parseJapanDetail(value: unknown, sourceId: string) {
  const parsed = japanDetailSchema.parse(value);
  return { id: sourceId, title: parsed.title, url: parsed.url, description: parsed.text };
}

function postedTimestamp(value: SourceSearchHit) {
  for (const key of ["postedDate", "posted_at", "postedAt", "date", "created_at", "createdAt"] as const) {
    const candidate = value[key as keyof SourceSearchHit];
    if (typeof candidate !== "string") continue;
    const timestamp = Date.parse(candidate);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return undefined;
}

export const MAX_SOURCE_SEARCH_CALLS = 5;
export const MAX_SOURCE_FALLBACK_QUERIES = 5;

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
    if (queries.length >= MAX_SOURCE_FALLBACK_QUERIES) break;
  }
  return queries;
}

export function dedupeSearchResults(results: readonly SourceSearchHit[]) {
  const ids = new Set<string>();
  const urls = new Set<string>();
  return results.filter(result => {
    const url = normalizeUrl(result.url);
    if (ids.has(result.id) || urls.has(url)) return false;
    ids.add(result.id);
    urls.add(url);
    return true;
  });
}

function cliFailure(label: string, result: { stderr: string; code: number }) {
  return new Error(`${label} search failed: ${result.stderr.trim() || result.code}`);
}

type CliPluginSpec = Readonly<{
  manifest: SourceManifest;
  searchArgs(request: SourceSearchRequest, query: string): string[];
  parseSearch(value: unknown): SourceSearchResponse;
  detailArg(ref: { id: string; url: string }): string;
  parseDetail(value: unknown, sourceId: string): SourceDetail;
  matchesDetailUrl?(sourceId: string, expectedUrl: string, actualUrl: string): boolean;
  fallback?: boolean;
}>;

function createCliPlugin(spec: CliPluginSpec): JobSourcePlugin {
  return {
    manifest: spec.manifest,
    fallbackQueries: spec.fallback ? sanitizeFallbackQueries : undefined,
    async search(request, context) {
      const runSearch = async (query: string, fallback = false) => {
        if (fallback && !context.searchAttempt()) return undefined;
        if (!context.runCli) throw new Error(`${spec.manifest.label} CLI is unavailable`);
        const args = spec.searchArgs(request, query);
        const result = await context.request(signal => context.runCli!(args, { signal, env: context.env, source: context.source }));
        if (result.code !== 0) throw cliFailure(spec.manifest.label, result);
        try { return spec.parseSearch(JSON.parse(result.stdout)); }
        catch (error) { throw new Error(`${spec.manifest.label} returned an invalid search response: ${error instanceof Error ? error.message : String(error)}`); }
      };

      const initial = await runSearch(request.query);
      if (!initial) throw new Error(`${spec.manifest.label} search did not start`);
      if (!spec.fallback) return initial;
      let results = dedupeSearchResults(initial.results);
      for (const fallbackQuery of sanitizeFallbackQueries(request.fallbackQueries)) {
        if (results.length || fallbackQuery === request.query) {
          if (results.length) break;
          continue;
        }
        const fallback = await runSearch(fallbackQuery, true);
        if (!fallback) break;
        results = dedupeSearchResults([...results, ...fallback.results]);
      }
      const capped = results.slice(0, request.limit);
      return { meta: { count: capped.length }, results: capped };
    },
    async details(ref, context) {
      if (!context.runCli) throw new Error(`${spec.manifest.label} CLI is unavailable`);
      const result = await context.request(signal => context.runCli!(
        ["detail", spec.detailArg(ref), "--format", "json"],
        { signal, env: context.env, source: context.source },
      ));
      if (result.code !== 0) throw new Error(`${spec.manifest.label} detail failed: ${result.stderr.trim() || result.code}`);
      let detail: SourceDetail;
      try { detail = spec.parseDetail(JSON.parse(result.stdout), ref.id); }
      catch (error) { throw new Error(`${spec.manifest.label} returned an invalid detail response: ${error instanceof Error ? error.message : String(error)}`); }
      const matches = spec.matchesDetailUrl?.(ref.id, ref.url, detail.url) ?? ref.url === detail.url;
      if (!matches) throw new Error(`${spec.manifest.label} detail provenance mismatch`);
      return detail;
    },
    matchesDetailUrl: spec.matchesDetailUrl,
  };
}

const defaultPolicy: SourcePolicy = { maxRequestsPerRun: 20, maxConcurrentRequests: 1, timeoutMs: 30_000, minimumDelayMs: 0 };

const freehireManifest = manifest({
  id: "freehire",
  label: "FreeHire",
  version: "1.0.0",
  capabilities: { search: true, detail: true, pagination: false, location: true, freshness: true, remote: true, activeStatus: false },
  policy: defaultPolicy,
  defaults: { maxAgeDays: 9_999 },
  guidance: {
    strengths: ["Broad remote and location-aware job discovery."],
    caveats: ["Search results are discovery metadata until details are fetched."],
    query: "Use criteria locations as the location/city filter when useful.",
  },
});

const linkedinManifest = manifest({
  id: "linkedin",
  label: "LinkedIn",
  version: "1.0.0",
  capabilities: { search: true, detail: true, pagination: false, location: true, freshness: true, remote: true, activeStatus: false },
  policy: { ...defaultPolicy, maxConcurrentRequests: 1 },
  defaults: { maxAgeDays: 9_999 },
  guidance: {
    strengths: ["Large professional network with location-aware discovery."],
    caveats: ["Every search requires a concrete location and detail URLs may be regional."],
    query: "LinkedIn requires a non-empty location for every search. Use one of criteria.locations; make separate calls for multiple locations within the five-call budget.",
  },
});

const japanManifest = (id: "tokyodev" | "japan-dev", label: string): SourceManifest => manifest({
  id,
  label,
  version: "1.0.0",
  capabilities: { search: true, detail: true, pagination: false, location: false, freshness: true, remote: false, activeStatus: false },
  policy: defaultPolicy,
  defaults: { maxAgeDays: 45 },
  preflight: true,
  guidance: {
    strengths: ["Japan-focused board with role-oriented search."],
    caveats: ["Country is fixed to Japan; location and eligibility are evaluated after discovery."],
    query: "The selected Japan-board adapter already fixes country to Japan. Use one concise role phrase per search call from criteria.roles; do not concatenate every role into one query. Build queries from that role and relevant criteria.keywords/skills only; if useful, add Japan-specific terms only. Do not include non-Japan values from criteria.locations in the source query. Use location, relocation, work authorization, and remote preferences for post-search evaluation/scoring, not as Japan-board query tokens.",
  },
});

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

export function matchesLinkedInDetailUrl(sourceId: string, expectedUrl: string, actualUrl: string) {
  if (!/^\d{6,}$/.test(sourceId)) return false;
  return linkedinUrlId(expectedUrl) === sourceId && linkedinUrlId(actualUrl) === sourceId;
}

const freehirePlugin = createCliPlugin({
  manifest: freehireManifest,
  searchArgs: (request, query) => {
    const args = ["search", "--query", query, "--limit", String(request.limit), "--format", "json"];
    if (request.location) args.push("--city", request.location);
    if (request.maxAgeDays !== undefined) args.push("--jobage", String(request.maxAgeDays));
    return args;
  },
  parseSearch: parseDefaultSearch,
  detailArg: ref => {
    if (ref.id.includes("/")) throw new Error("resultId contains an invalid command argument");
    return ref.id;
  },
  parseDetail: parseDefaultDetail,
});

const linkedinPlugin = createCliPlugin({
  manifest: linkedinManifest,
  searchArgs: (request, query) => {
    if (!request.location) throw new Error("LinkedIn search requires a location");
    const args = ["search", "--location", request.location, "--query", query, "--limit", String(request.limit), "--format", "json"];
    if (request.maxAgeDays !== undefined) args.push("--jobage", String(request.maxAgeDays));
    return args;
  },
  parseSearch: parseDefaultSearch,
  detailArg: ref => ref.id,
  parseDetail: parseDefaultDetail,
  matchesDetailUrl: matchesLinkedInDetailUrl,
});

function japanPlugin(id: "tokyodev" | "japan-dev", label: string): JobSourcePlugin {
  return createCliPlugin({
    manifest: japanManifest(id, label),
    fallback: true,
    searchArgs: (request, query) => {
      const args = ["search", "--source", id, "--query", query, "--country", "Japan", "--limit", String(request.limit), "--format", "json"];
      if (request.maxAgeDays !== undefined) args.push("--jobage", String(request.maxAgeDays));
      return args;
    },
    parseSearch: parseJapanSearch,
    detailArg: ref => ref.url,
    parseDetail: parseJapanDetail,
  });
}

export const builtInSourcePlugins: readonly JobSourcePlugin[] = Object.freeze([
  freehirePlugin,
  linkedinPlugin,
  japanPlugin("tokyodev", "TokyoDev"),
  japanPlugin("japan-dev", "Japan Dev"),
]);

export function createDeclarativeSourcePlugin(sourceValue: CustomJobSource): JobSourcePlugin {
  const source = validateCustomSourceDefinition(sourceValue);
  const customManifest = manifest({
    id: source.key,
    label: source.label,
    version: "1.0.0",
    capabilities: { search: true, detail: true, pagination: false, location: true, freshness: false, remote: false, activeStatus: false },
    policy: { maxRequestsPerRun: 10, maxConcurrentRequests: 1, timeoutMs: CUSTOM_SOURCE_TIMEOUT_MS, minimumDelayMs: 0 },
    guidance: {
      strengths: ["Declarative HTTP source with a bounded JSON or HTML parser."],
      caveats: ["Results are untrusted discovery data and may be stale or incomplete."],
      query: "Use the supplied query and location templates; evaluate freshness, remote fit, and eligibility after fetching details.",
    },
  });
  return {
    manifest: customManifest,
    async search(request, context) {
      const adapter = createCustomSourceAdapter(source, { fetcher: context.fetcher, timeoutMs: customManifest.policy.timeoutMs });
      return context.request(signal => adapter.search(request.query, request.location, request.limit, signal));
    },
    async details(ref, context) {
      const adapter = createCustomSourceAdapter(source, { fetcher: context.fetcher, timeoutMs: customManifest.policy.timeoutMs });
      return context.request(signal => adapter.detail(ref.id, ref.url, signal));
    },
    matchesDetailUrl: (_sourceId, expectedUrl, actualUrl) => normalizeUrl(expectedUrl) === normalizeUrl(actualUrl),
  };
}

export type ResolvedSource = Readonly<{
  key: JobSource;
  plugin: JobSourcePlugin;
  custom?: CustomJobSource;
}>;
export class SourceRegistry {
  private readonly plugins = new Map<JobSource, JobSourcePlugin>();

  constructor(plugins: readonly JobSourcePlugin[] = builtInSourcePlugins) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: JobSourcePlugin) {
    const validated = validateSourcePlugin(plugin);
    if (this.plugins.has(validated.manifest.id)) throw new Error(`Source plugin ${validated.manifest.id} is already registered.`);
    this.plugins.set(validated.manifest.id, validated);
    return this;
  }

  resolve(key: JobSource, custom?: CustomJobSource): JobSourcePlugin {
    const plugin = this.plugins.get(key);
    if (plugin) return plugin;
    if (custom?.key === key) return createDeclarativeSourcePlugin(custom);
    throw new Error(`Enabled source ${key} is not configured.`);
  }

  resolveEnabled(keys: readonly string[], customSources: readonly CustomJobSource[] = []): ResolvedSource[] {
    if (!keys.length) throw new Error("Enable at least one job source before scraping.");
    if (new Set(keys).size !== keys.length) throw new Error("Enabled sources must be unique.");
    return keys.map(key => {
      const custom = customSources.find(source => source.key === key);
      return { key, custom, plugin: this.resolve(key, custom) };
    });
  }

  manifests(keys?: readonly JobSource[]) {
    const selected = keys ?? [...this.plugins.keys()];
    return selected.map(key => this.resolve(key).manifest);
  }
  listEnabled(keys: readonly string[], customSources: readonly CustomJobSource[] = []) {
    return this.resolveEnabled(keys, customSources).map(source => source.plugin.manifest);
  }

  list() {
    return [...this.plugins.values()].map(plugin => plugin.manifest);
  }
}

export function createSourceRegistry(plugins: readonly JobSourcePlugin[] = builtInSourcePlugins) {
  return new SourceRegistry(plugins);
}

export const defaultSourceRegistry = createSourceRegistry();

export function sourceDetailUrlMatches(plugin: JobSourcePlugin, sourceId: string, expectedUrl: string, actualUrl: string) {
  return plugin.matchesDetailUrl?.(sourceId, expectedUrl, actualUrl) ?? expectedUrl === actualUrl;
}

export function sourcePostedTimestamp(value: SourceSearchHit) {
  return postedTimestamp(value);
}
