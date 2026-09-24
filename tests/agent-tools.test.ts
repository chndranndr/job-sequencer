import test from "node:test";
import assert from "node:assert/strict";
import { createRestrictedScrapeSession, resolveLiveScrapeSession, scrapeToolCatalog } from "../src/server/agent.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { createSourceRegistry, type JobSourcePlugin } from "../src/server/source-plugins.js";
import { createAgentMcpServer } from "../src/server/tools.js";
import { createAgentSearchTools } from "../src/server/search/tools.js";

test("restricted scrape session exposes exactly the four bounded search tools", async () => {
  const session = await createRestrictedScrapeSession();
  try {
    const names = session.getActiveToolNames?.() ?? [];
    const bare = names.map((name) => (name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name)).sort();
    assert.deepEqual(bare, ["fetchJobDetails", "finishSearch", "inspectSearchState", "searchJobs"]);
    assert.equal(names.some((name) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(name.toLowerCase())), false);
  } finally {
    session.dispose();
  }
});
test("live session resolver uses an injected fixture-only source registry", () => {
  const plugin: JobSourcePlugin = {
    manifest: {
      id: "fixture",
      label: "Fixture",
      version: "1.0.0",
      capabilities: { search: true, detail: false, pagination: false, location: true, freshness: false, remote: true, activeStatus: false },
      policy: { maxRequestsPerRun: 2, maxConcurrentRequests: 1, timeoutMs: 1_000, minimumDelayMs: 0 },
      guidance: { strengths: ["Fixture source."], caveats: ["Fixture data is local."], query: "Use the fixture query." },
    },
    search: async () => ({ meta: { count: 0 }, results: [] }),
  };
  const registry = createSourceRegistry([plugin]);
  const resolved = resolveLiveScrapeSession({ ...defaultSettings, enabledSources: ["fixture"] }, undefined, "fixture", registry);
  assert.equal(resolved.source, "fixture");
  assert.equal(resolved.plugin?.manifest.id, "fixture");
  assert.equal(resolved.toolSet.searchJobs.name, "searchJobs");
  const adaptiveTools = createAgentSearchTools({
    sources: [{ key: "fixture", registry }],
    goal: { criteria: defaultCriteria, enabledSources: ["fixture"] },
  });
  const supplied = resolveLiveScrapeSession({ ...defaultSettings, enabledSources: ["fixture"] }, adaptiveTools, "freehire", registry);
  assert.equal(supplied.toolSet, adaptiveTools);
});

test("concurrent MCP tool handlers serialize without corrupting budget or provenance", async () => {
  let hits = 0;
  const plugin: JobSourcePlugin = {
    manifest: {
      id: "fixture",
      label: "Fixture",
      version: "1.0.0",
      capabilities: { search: true, detail: false, pagination: false, location: true, freshness: false, remote: true, activeStatus: false },
      policy: { maxRequestsPerRun: 8, maxConcurrentRequests: 1, timeoutMs: 1_000, minimumDelayMs: 0 },
      guidance: { strengths: ["Fixture source."], caveats: ["Fixture data is local."], query: "Use the fixture query." },
    },
    search: async () => {
      hits += 1;
      return { meta: { count: 1 }, results: [{ id: `hit-${hits}`, title: "Engineer", url: `https://example.test/job-${hits}`, company: "Example", location: "Remote" }] };
    },
  };
  const registry = createSourceRegistry([plugin]);
  const tools = createAgentSearchTools({
    sources: [{ key: "fixture", registry }],
    goal: { criteria: defaultCriteria, enabledSources: ["fixture"] },
  });
  const bundle = createAgentMcpServer("search", scrapeToolCatalog(tools).definitions);
  const searchDefinition = bundle.definitions.find((candidate) => candidate.name === "searchJobs");
  if (!searchDefinition) throw new Error("searchJobs missing from bundle");
  const calls = await Promise.all([0, 1, 2, 3, 4].map((index) =>
    searchDefinition.handler({ query: `backend ${index}`, limit: 5 }, { requestId: `concurrent-${index}` } as never),
  ));
  assert.equal(calls.every((call) => call.isError !== true), true, "every concurrent search completes");
  const snapshot = tools.state.inspect();
  const searchAttempts = snapshot.attempts.filter((attempt) => attempt.operation === "search");
  assert.equal(searchAttempts.length, 5, "five search attempts recorded exactly once");
  assert.equal(snapshot.remainingSearchCalls, 15, "budget decremented once per call");
  assert.equal(snapshot.provenanceCount, 5, "provenance recorded per unique hit");
});
