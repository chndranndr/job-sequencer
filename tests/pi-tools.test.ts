import test from "node:test";
import assert from "node:assert/strict";
import { createRestrictedScrapeSession, resolveLiveScrapeSession } from "../src/server/pi.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { createSourceRegistry, type JobSourcePlugin } from "../src/server/source-plugins.js";
import { createAgentSearchTools } from "../src/server/search/tools.js";

test("restricted scrape Pi session has exactly the four bounded search tools", async () => {
  const session = await createRestrictedScrapeSession();
  try {
    assert.deepEqual(session.getActiveToolNames().sort(), ["fetchJobDetails", "finishSearch", "inspectSearchState", "searchJobs"]);
    assert.equal(session.getActiveToolNames().some((name) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(name)), false);
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
    sources: [{ key: "fixture", manifest: plugin.manifest, registry }],
    goal: { criteria: defaultCriteria, enabledSources: ["fixture"] },
  });
  const supplied = resolveLiveScrapeSession({ ...defaultSettings, enabledSources: ["fixture"] }, adaptiveTools, "freehire", registry);
  assert.equal(supplied.toolSet, adaptiveTools);
});
