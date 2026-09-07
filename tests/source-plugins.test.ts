import test from "node:test";
import assert from "node:assert/strict";
import {
  builtInSourcePlugins,
  createSourceRegistry,
  SourcePolicyLedger,
  type JobSourcePlugin,
  type SourceDetail,
  type SourceManifest,
  type SourcePluginContext,
  type SourcePolicy,
  type SourceSearchResponse,
} from "../src/server/source-plugins.js";
import { createScrapeTools, validateScrapeResult } from "../src/server/scrape.js";
import { createAgentSearchTools } from "../src/server/search/tools.js";
import { defaultCriteria } from "../src/server/config.js";

const hit = { id: "fixture-1", title: "Backend Engineer", company: "Fixture Co", location: "Remote", url: "https://fixture.example/jobs/1" };
const detail: SourceDetail = { id: hit.id, title: hit.title, url: hit.url, description: "Build reliable APIs." };

function fixtureManifest(policy: Partial<SourcePolicy> = {}): SourceManifest {
  return {
    id: "fixture",
    label: "Fixture",
    version: "1.0.0",
    capabilities: { search: true, detail: true, pagination: false, location: true, freshness: false, remote: true, activeStatus: false },
    policy: { maxRequestsPerRun: 10, maxConcurrentRequests: 1, timeoutMs: 1_000, minimumDelayMs: 0, ...policy },
    guidance: { strengths: ["Deterministic fixture source."], caveats: ["Fixture data is not live."], query: "Use the fixture query." },
  };
}

type FixtureConfig = {
  manifest?: SourceManifest;
  search?: (context: SourcePluginContext) => Promise<SourceSearchResponse>;
  details?: (context: SourcePluginContext) => Promise<SourceDetail>;
};

function fixturePlugin(config: FixtureConfig = {}): JobSourcePlugin {
  return {
    manifest: config.manifest ?? fixtureManifest(),
    search: async (_request, context) => context.request(signal => config.search ? config.search({ ...context, signal }) : Promise.resolve({ meta: { count: 1 }, results: [hit] })),
    details: async (ref, context) => config.details ? config.details(context) : context.request(async () => ({ ...detail, id: ref.id, url: ref.url })),
  };
}

function fixtureTools(config: FixtureConfig = {}) {
  const plugin = fixturePlugin(config);
  const registry = createSourceRegistry([plugin]);
  return createScrapeTools({ source: "fixture", registry });
}

async function callSearch(tools: ReturnType<typeof fixtureTools>) {
  const output = await tools.searchJobs.execute("search", { query: "backend", location: "Remote", limit: 5 }, undefined, undefined, undefined as never);
  const block = output.content[0];
  if (block.type !== "text") throw new Error("search result was not text");
  return JSON.parse(block.text) as { meta: { count: number }; results: Array<typeof hit> };
}

test("registered plugins expose bounded manifests and preserve provenance", async () => {
  const tools = fixtureTools();
  const result = await callSearch(tools);
  assert.equal(result.results[0]?.id, hit.id);
  const fetched = await tools.fetchJobDetails.execute("detail", { resultId: hit.id }, undefined, undefined, undefined as never);
  const block = fetched.content[0];
  if (block.type !== "text") throw new Error("detail result was not text");
  assert.equal(JSON.parse(block.text).id, hit.id);
  assert.doesNotThrow(() => validateScrapeResult({ jobs: [{ sourceId: hit.id, source: "fixture", url: hit.url, company: hit.company, role: hit.title, location: hit.location, posting: detail.description, score: 80, reason: "fixture", strengths: [], gaps: [] }] }, tools.provenance, 5, "fixture"));
  const manifest = createSourceRegistry([fixturePlugin()]).manifests()[0];
  assert.deepEqual(manifest?.capabilities, { search: true, detail: true, pagination: false, location: true, freshness: false, remote: true, activeStatus: false });
  assert.ok(manifest?.policy.maxRequestsPerRun <= 100);
});
test("registry rejects capability declarations that do not match plugin implementations", () => {
  const base = fixturePlugin();
  const { details: _details, ...withoutDetails } = base;
  assert.throws(() => createSourceRegistry([{
    ...withoutDetails,
    manifest: base.manifest,
  }]), /detail capability/i);
  const malformedDetails = fixturePlugin();
  Object.defineProperty(malformedDetails, "details", { value: "not-a-function" });
  assert.throws(() => createSourceRegistry([malformedDetails]), /detail capability/i);
  assert.throws(() => createSourceRegistry([{
    ...base,
    manifest: { ...base.manifest, capabilities: { ...base.manifest.capabilities, detail: false } },
  }]), /detail capability/i);
  assert.throws(() => createSourceRegistry([{
    ...base,
    manifest: { ...base.manifest, capabilities: { ...base.manifest.capabilities, search: false } },
  }]), /search capability/i);
  assert.throws(() => createScrapeTools({
    source: "fixture",
    plugin: { ...withoutDetails, manifest: base.manifest },
  }), /detail capability/i);
});
test("source URL contracts reject non-HTTP schemes and credentials", async () => {
  for (const url of ["ftp://fixture.example/jobs/1", "https://user:pass@fixture.example/jobs/1"]) {
    const tools = fixtureTools({ search: async () => ({ meta: { count: 1 }, results: [{ ...hit, url }] }) });
    await assert.rejects(() => callSearch(tools), /HTTP\(S\)|credentials/i);
    assert.throws(() => validateScrapeResult({
      jobs: [{ sourceId: hit.id, source: "fixture", url, company: hit.company, role: hit.title, location: hit.location, posting: detail.description, score: 80, reason: "fixture", strengths: [], gaps: [] }],
    }, new Map()), /HTTP\(S\)|credentials/i);
  }
});

test("search contract rejects malformed responses and removes duplicates", async () => {
  const tools = fixtureTools({
    search: async () => ({ meta: { count: 3 }, results: [hit, { ...hit, id: "fixture-2" }, { ...hit, id: "fixture-3" }] }),
  });
  const result = await callSearch(tools);
  assert.equal(result.results.length, 1);
  const malformed = fixtureTools({ search: async () => ({ meta: { count: 1 }, results: [{ ...hit, id: "" }] }) });
  await assert.rejects(() => callSearch(malformed), /invalid|ID|too_small/i);
});

test("detail contract rejects provenance mismatches", async () => {
  const tools = fixtureTools({ details: async context => context.request(async () => ({ ...detail, id: "fabricated" })) });
  await callSearch(tools);
  await assert.rejects(() => tools.fetchJobDetails.execute("detail", { resultId: hit.id }, undefined, undefined, undefined as never), /provenance mismatch/i);
});

test("source policy propagates aborts and enforces timeouts", async () => {
  const abortTools = fixtureTools({ search: async () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = abortTools.searchJobs.execute("abort", { query: "backend", location: "", limit: 1 }, controller.signal, undefined, undefined as never);
  controller.abort();
  await assert.rejects(pending);

  const timeoutTools = fixtureTools({ manifest: fixtureManifest({ timeoutMs: 100 }), search: async () => new Promise(() => {}) });
  await assert.rejects(() => callSearch(timeoutTools), /timed out/i);
});

test("source policy counts requests and limits concurrent starts", async () => {
  const budgetTools = fixtureTools({ manifest: fixtureManifest({ maxRequestsPerRun: 2 }) });
  await callSearch(budgetTools);
  await callSearch(budgetTools);
  await assert.rejects(() => callSearch(budgetTools), /budget exhausted/i);

  const ledger = new SourcePolicyLedger("Fixture", { maxRequestsPerRun: 2, maxConcurrentRequests: 1, timeoutMs: 1_000, minimumDelayMs: 0 });
  let active = 0;
  let peak = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const run = () => ledger.run(undefined, async () => {
    active++;
    peak = Math.max(peak, active);
    if (peak === 1) await firstGate;
    active--;
  });
  const first = run();
  await Promise.resolve();
  const second = run();
  await Promise.resolve();
  assert.equal(peak, 1);
  releaseFirst();
  await Promise.all([first, second]);
});
test("source policy keeps timed-out permits until operations settle", async () => {
  const ledger = new SourcePolicyLedger("Fixture", { maxRequestsPerRun: 2, maxConcurrentRequests: 1, timeoutMs: 25, minimumDelayMs: 0 });
  let releaseFirst!: () => void;
  let secondStarted = false;
  const firstOperation = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = ledger.run(undefined, async () => firstOperation);
  await assert.rejects(first, /timed out/i);
  const second = ledger.run(undefined, async () => { secondStarted = true; });
  assert.equal(secondStarted, false);
  releaseFirst();
  await second;
  assert.equal(secondStarted, true);
});
test("source policy spaces concurrent starts by the minimum delay", async () => {
  const ledger = new SourcePolicyLedger("Fixture", { maxRequestsPerRun: 2, maxConcurrentRequests: 2, timeoutMs: 1_000, minimumDelayMs: 50 });
  const starts: number[] = [];
  await Promise.all([
    ledger.run(undefined, async () => { starts.push(Date.now()); }),
    ledger.run(undefined, async () => { starts.push(Date.now()); }),
  ]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 45, `starts were ${starts[1] - starts[0]}ms apart`);
});
test("all built-in plugins preserve their fixture transport contracts", async () => {
  for (const plugin of builtInSourcePlugins) {
    const source = plugin.manifest.id;
    const id = source === "linkedin" ? "123456789" : `${source}-fixture`;
    const url = source === "linkedin" ? `https://www.linkedin.com/jobs/view/${id}` : `https://fixture.example/${source}/jobs/1`;
    const tools = createScrapeTools({
      source,
      plugin,
      runCli: async args => {
        if (args[0] === "search") {
          const result = { id, title: "Backend Engineer", company: "Fixture Co", location: "Remote", url };
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify(plugin.manifest.preflight ? { count: 1, results: [result] } : { meta: { count: 1 }, results: [result] }),
          };
        }
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify(plugin.manifest.preflight ? { url, title: "Backend Engineer", text: "Build reliable APIs." } : { id, title: "Backend Engineer", url, description: "Build reliable APIs." }),
        };
      },
    });
    await callSearch(tools);
    await tools.fetchJobDetails.execute("detail", { resultId: id }, undefined, undefined, undefined as never);
  }
});
test("agent inspection exposes enabled source capabilities and policy", async () => {
  const plugin = fixturePlugin();
  const registry = createSourceRegistry([plugin]);
  const tools = createAgentSearchTools({
    sources: [{ key: "fixture", registry }],
    goal: { criteria: defaultCriteria, enabledSources: ["fixture"] },
  });
  const output = await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never);
  const block = output.content[0];
  if (block.type !== "text") throw new Error("inspection result was not text");
  const inspected = JSON.parse(block.text) as { sources: Array<{ id: string; capabilities: SourceManifest["capabilities"]; policy: SourcePolicy }> };
  assert.equal(inspected.sources[0]?.id, "fixture");
  assert.equal(inspected.sources[0]?.capabilities.location, true);
  assert.equal(inspected.sources[0]?.policy.maxConcurrentRequests, 1);
});
