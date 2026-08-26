import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultCriteria, defaultSettings, readSettings, writeSettings } from "../src/server/config.js";
import { createCustomSourceAdapter, validateCustomSourceDefinition } from "../src/server/custom-source.js";
import { createMultiSourceScrapeExecutor } from "../src/server/runs.js";
import { createScrapeTools, validateScrapeResult } from "../src/server/scrape.js";
import type { CustomJobSource } from "../src/shared.js";
import { openDatabase } from "../src/server/db.js";
import { buildServer } from "../src/server/app.js";

test("settings migrate legacy source to enabledSources and persist multiple built-ins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-custom-source-tdd-"));
  try {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ source: "linkedin" }));
    const migrated = await readSettings(dir);
    assert.deepEqual(migrated.enabledSources, ["linkedin"]);

    const saved = await writeSettings(dir, { ...migrated, enabledSources: ["linkedin", "tokyodev"] });
    assert.deepEqual(saved.enabledSources, ["linkedin", "tokyodev"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const jsonSource: CustomJobSource = {
  key: "acme-board",
  label: "Acme Board",
  searchUrlTemplate: "https://jobs.example.test/search?q={{query}}&location={{location}}&limit={{limit}}",
  detailUrlTemplate: "https://jobs.example.test/api/jobs/{{id}}",
  parser: {
    format: "json",
    search: { resultsPath: "data.jobs", fields: { id: "id", title: "title", company: "company", location: "location", url: "url" } },
    detail: { fields: { id: "id", title: "title", url: "url", description: "description" } },
  },
};

test("custom source validation rejects unsafe templates and repairs empty selection", async () => {
  assert.throws(() => validateCustomSourceDefinition({ ...jsonSource, searchUrlTemplate: "ftp://jobs.example.test/?q={{query}}" }), /HTTP|HTTPS/i);
  assert.throws(() => validateCustomSourceDefinition({ ...jsonSource, searchUrlTemplate: "https://user:pass@jobs.example.test/?q={{query}}" }), /credentials/i);
  assert.throws(() => validateCustomSourceDefinition({ ...jsonSource, searchUrlTemplate: "https://jobs.example.test/?q={{query}}\n" }), /control|URL/i);
  assert.throws(() => validateCustomSourceDefinition({ ...jsonSource, searchUrlTemplate: "https://jobs.example.test/?q={{command}}" }), /placeholder/i);
  assert.throws(() => validateCustomSourceDefinition({ ...jsonSource, searchUrlTemplate: "https://{{query}}.example.test/?q=x" }), /host/i);
  assert.throws(() => validateCustomSourceDefinition({ ...jsonSource, label: "Acme\nBoard" }), /control/i);
  const dir = await mkdtemp(join(tmpdir(), "pjs-custom-validation-"));
  try {
    await assert.rejects(writeSettings(dir, { ...defaultSettings, customSources: [jsonSource, { ...jsonSource }] }));
    await assert.rejects(writeSettings(dir, { ...defaultSettings, customSources: [{ ...jsonSource, key: "freehire" }] }));
    const repaired = await writeSettings(dir, { ...defaultSettings, enabledSources: [] });
    assert.deepEqual(repaired.enabledSources, ["freehire"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom JSON adapter bounds interpolation, normalizes relative URLs, and enforces same-run provenance", async () => {
  const calls: string[] = [];
  let detail = { id: "42", title: "Backend Engineer", url: "/jobs/42", description: "Build APIs" };
  const tools = createScrapeTools({
    source: jsonSource.key,
    customSource: jsonSource,
    fetcher: async (input) => {
      calls.push(input);
      if (input.includes("/search?")) return new Response(JSON.stringify({ data: { jobs: [{ id: "42", title: "Backend Engineer", company: "Acme", location: "Remote", url: "/jobs/42" }] } }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(detail), { headers: { "content-type": "application/json" } });
    },
  });
  const search = await tools.searchJobs.execute("search", { query: "backend engineer&bad", location: "Jakarta", limit: 5 }, undefined, undefined, undefined as never);
  const searchBlock = search.content[0];
  if (searchBlock.type !== "text") throw new Error("custom JSON search was not text");
  const parsed = JSON.parse(searchBlock.text) as { results: Array<{ id: string; url: string }> };
  assert.deepEqual(parsed.results[0], { id: "42", title: "Backend Engineer", company: "Acme", location: "Remote", url: "https://jobs.example.test/jobs/42" });
  assert.match(calls[0], /q=backend%20engineer%26bad/);
  assert.match(calls[0], /limit=5/);
  const detailResult = await tools.fetchJobDetails.execute("detail", { resultId: "42" }, undefined, undefined, undefined as never);
  const detailBlock = detailResult.content[0];
  if (detailBlock.type !== "text") throw new Error("custom JSON detail was not text");
  assert.deepEqual(JSON.parse(detailBlock.text), { id: "42", title: "Backend Engineer", url: "https://jobs.example.test/jobs/42", description: "Build APIs" });
  assert.equal(tools.detailDescriptions.get("42"), "Build APIs");
  assert.doesNotThrow(() => validateScrapeResult({ jobs: [{ sourceId: "42", source: jsonSource.key, url: "https://jobs.example.test/jobs/42", company: "Acme", role: "Backend Engineer", location: "Remote", posting: "Build APIs", score: 81, reason: "fit", strengths: [], gaps: [] }] }, tools.provenance));
  await assert.rejects(tools.fetchJobDetails.execute("fabricated", { resultId: "not-returned" }, undefined, undefined, undefined as never), /was not returned by searchJobs/);
  detail = { ...detail, id: "fabricated" };
  await assert.rejects(tools.fetchJobDetails.execute("bad-id", { resultId: "42" }, undefined, undefined, undefined as never), /provenance mismatch/);
  detail = { ...detail, id: "42", url: "/jobs/other" };
  await assert.rejects(tools.fetchJobDetails.execute("bad-url", { resultId: "42" }, undefined, undefined, undefined as never), /provenance mismatch/);
});

test("custom HTML adapter extracts bounded selectors and relative links", async () => {
  const source: CustomJobSource = {
    key: "html-board",
    label: "HTML Board",
    searchUrlTemplate: "https://html.example.test/search?q={{query}}&limit={{limit}}",
    detailUrlTemplate: "https://html.example.test/jobs/{{id}}",
    parser: {
      format: "html",
      search: { itemSelector: "article.job", fields: { id: { selector: "[data-id]", attribute: "data-id" }, title: { selector: ".title" }, company: { selector: ".company" }, location: { selector: ".location" }, url: { selector: "a", attribute: "href" } } },
      detail: { fields: { id: { selector: "[data-id]", attribute: "data-id" }, title: { selector: "h1" }, url: { selector: "link[rel=canonical]", attribute: "href" }, description: { selector: ".description" } } },
    },
  };
  const tools = createScrapeTools({ source: source.key, customSource: source, fetcher: async (input) => input.includes("/search?")
    ? new Response('<article class="job" data-id="html-1"><h2 class="title">Platform Engineer</h2><span class="company">HTML Co</span><span class="location">Tokyo</span><a href="/jobs/html-1">Open</a></article>')
    : new Response('<link rel="canonical" href="/jobs/html-1"><main data-id="html-1"><h1>Platform Engineer</h1><div class="description">Operate platforms.</div></main>') });
  const search = await tools.searchJobs.execute("search", { query: "platform", location: "", limit: 1 }, undefined, undefined, undefined as never);
  const searchBlock = search.content[0];
  if (searchBlock.type !== "text") throw new Error("custom HTML search was not text");
  assert.deepEqual(JSON.parse(searchBlock.text).results[0], { id: "html-1", title: "Platform Engineer", company: "HTML Co", location: "Tokyo", url: "https://html.example.test/jobs/html-1" });
  const detail = await tools.fetchJobDetails.execute("detail", { resultId: "html-1" }, undefined, undefined, undefined as never);
  const detailBlock = detail.content[0];
  if (detailBlock.type !== "text") throw new Error("custom HTML detail was not text");
  assert.deepEqual(JSON.parse(detailBlock.text), { id: "html-1", title: "Platform Engineer", url: "https://html.example.test/jobs/html-1", description: "Operate platforms." });
});

test("custom adapter enforces the response-size ceiling", async () => {
  const adapter = createCustomSourceAdapter(jsonSource, { maxBytes: 16, fetcher: async () => new Response("x".repeat(100)) });
  await assert.rejects(adapter.search("backend", "", 1), /too large/);
});

test("multi-source executor calls every enabled source, skips disabled sources, and keeps partial success", async () => {
  const calls: string[] = [];
  const executor = createMultiSourceScrapeExecutor(async (_context, source) => {
    calls.push(source);
    if (source === "linkedin") throw new Error("fixture failure");
    const id = `${source}-1`;
    const url = `https://${source}.example.test/jobs/1`;
    return { result: { jobs: [{ sourceId: id, source, url, company: source, role: "Engineer", location: "Remote", posting: "Build", score: 81, reason: "fit", strengths: [], gaps: [] }] }, provenance: new Map([[id, url]]), warnings: source === "tokyodev" ? ["TokyoDev returned results older than 45 days; verify that postings are still active."] : [] };
  });
  const output = await executor({ profile: "profile", criteria: { ...defaultCriteria, maxJobsPerRun: 10 }, settings: { ...defaultSettings, enabledSources: ["freehire", "linkedin", "tokyodev"] }, signal: new AbortController().signal });
  assert.deepEqual(calls, ["freehire", "linkedin", "tokyodev"]);
  assert.deepEqual((output.result as { jobs: Array<{ source: string }> }).jobs.map((job) => job.source), ["freehire", "tokyodev"]);
  assert.deepEqual(output.errors, ["LinkedIn: fixture failure"]);
  assert.deepEqual(output.warnings, ["TokyoDev returned results older than 45 days; verify that postings are still active."]);
  await assert.rejects(createMultiSourceScrapeExecutor(async () => ({ result: { jobs: [] }, provenance: new Map() }))({ profile: "profile", criteria: defaultCriteria, settings: { ...defaultSettings, enabledSources: ["freehire", "tokyodev"] }, signal: new AbortController().signal }), /no valid results/);
});

test("scrape API persists partial multi-source success and returns per-source errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-multi-api-"));
  const db = openDatabase(":memory:");
  const sourceExecutor = createMultiSourceScrapeExecutor(async (_context, source) => {
    if (source === "linkedin") throw new Error("fixture source failure token=do-not-leak\nAuthorization: Bearer bearer-secret\nhttps://user:password@example.test/jobs/1");
    const url = "https://freehire.example.test/jobs/1";
    return { result: { jobs: [{ sourceId: "free-1", source, url, company: "Example", role: "Backend", location: "Remote", posting: "APIs", score: 81, reason: "fit", strengths: [], gaps: [] }] }, provenance: new Map([["free-1", url]]), warnings: ["FreeHire returned results older than 45 days; verify that postings are still active."] };
  });
  await writeSettings(dir, { ...defaultSettings, enabledSources: ["freehire", "linkedin"] });
  const app = await buildServer({ dataDir: dir, db, scrapeExecutor: sourceExecutor });
  try {
    const settingsResponse = await app.inject({ method: "PUT", url: "/api/settings", payload: { ...defaultSettings, enabledSources: ["freehire", "linkedin"], customSources: [jsonSource] } });
    assert.equal(settingsResponse.statusCode, 200);
    assert.equal(settingsResponse.json().customSources[0].label, "Acme Board");
    const started = (await app.inject({ method: "POST", url: "/api/scrape" })).json() as { runId: string };
    let done: any;
    for (let attempt = 0; attempt < 30; attempt++) {
      done = (await app.inject({ url: `/api/runs/${started.runId}` })).json();
      if (done.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(done.status, "succeeded");
    assert.equal(done.summary.errors.length, 1);
    assert.match(done.summary.errors[0], /^LinkedIn: /);
    assert.deepEqual(done.summary.warnings, ["FreeHire returned results older than 45 days; verify that postings are still active."]);
    assert.doesNotMatch(done.summary.errors[0], /do-not-leak|bearer-secret|password/i);
    assert.equal((await app.inject({ url: "/api/jobs" })).json().jobs.length, 1);
  } finally {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
