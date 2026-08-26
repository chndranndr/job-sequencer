import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createScrapeTools, hydrateScrapeResult, validateScrapeResult } from "../src/server/scrape.js";

test("scrape tool session exposes only two tools and rejects unknown IDs", async () => {
  const tools = createScrapeTools({
    runCli: async () => { throw new Error("not reached"); },
  });
  assert.deepEqual(Object.keys(tools).sort(), ["fetchJobDetails", "searchJobs"]);
  assert.equal(Object.prototype.propertyIsEnumerable.call(tools, "detailDescriptions"), false);
  await assert.rejects(
    tools.fetchJobDetails.execute("call", { resultId: "fabricated-id" }, undefined, undefined, undefined as never),
    /was not returned by searchJobs/,
  );
});

test("hydration replaces metadata-only posting and preserves the model fallback when detail is missing", () => {
  const result = {
    jobs: [
      { sourceId: "full", source: "freehire", url: "https://jobs.example.test/full", company: "Example", role: "Engineer", location: "Remote", posting: "2026-08-15; metadata only", score: 81, reason: "fit", strengths: [], gaps: [] },
      { sourceId: "missing", source: "freehire", url: "https://jobs.example.test/missing", company: "Example", role: "Engineer", location: "Remote", posting: "model fallback", score: 80, reason: "fit", strengths: [], gaps: [] },
    ],
  };
  const hydrated = hydrateScrapeResult(result, new Map([["full", "Complete first paragraph.\n\nComplete second paragraph."]]));
  assert.equal(hydrated.jobs[0]?.posting, "Complete first paragraph.\n\nComplete second paragraph.");
  assert.equal(hydrated.jobs[1]?.posting, "model fallback");
  assert.equal(result.jobs[0]?.posting, "2026-08-15; metadata only");
});

test("scrape tools enforce the five-search run budget", async () => {
  const tools = createScrapeTools({ runCli: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) }) });
  for (let call = 0; call < 5; call++) await tools.searchJobs.execute(String(call), { query: "backend", location: "", limit: 1 }, undefined, undefined, undefined as never);
  await assert.rejects(tools.searchJobs.execute("six", { query: "backend", location: "", limit: 1 }, undefined, undefined, undefined as never), /at most five/);
});

test("empty combined Japan query falls back to a role and preserves provenance", async () => {
  const calls: string[][] = [];
  const id = "tokyodev:platform-engineer";
  const url = "https://www.tokyodev.com/companies/example/jobs/platform-engineer";
  const tools = createScrapeTools({
    source: "tokyodev",
    fallbackQueries: ["Backend Developer", "Platform Engineer"],
    runCli: async (args) => {
      calls.push(args);
      const query = args[args.indexOf("--query") + 1];
      const results = query === "Platform Engineer" ? [{ id, title: "Platform Engineer", company: "Example", location: "Japan", url }] : [];
      return { code: 0, stderr: "", stdout: JSON.stringify({ count: results.length, results }) };
    },
  });
  const search = await tools.searchJobs.execute("search", { query: "Fullstack Developer Backend Developer Platform Engineer Infrastructure", location: "", limit: 5 }, undefined, undefined, undefined as never);
  const block = search.content[0];
  if (block.type !== "text") throw new Error("search result was not text");
  const parsed = JSON.parse(block.text) as { results: Array<{ id: string; url: string }> };
  assert.deepEqual(calls.map((args) => args[args.indexOf("--query") + 1]), ["Fullstack Developer Backend Developer Platform Engineer Infrastructure", "Backend Developer", "Platform Engineer"]);
  assert.deepEqual(parsed.results, [{ id, title: "Platform Engineer", company: "Example", location: "Japan", url }]);
  assert.equal(tools.provenance.get(id), url);
  assert.doesNotThrow(() => validateScrapeResult({ jobs: [{ sourceId: id, source: "tokyodev", url, company: "Example", role: "Platform Engineer", location: "Japan", posting: "Operate platforms", score: 81, reason: "fit", strengths: [], gaps: [] }] }, tools.provenance, 5, "tokyodev"));
});

test("Japan-board fallback never exceeds the five-search run budget", async () => {
  let calls = 0;
  const tools = createScrapeTools({
    source: "japan-dev",
    fallbackQueries: ["one", "two", "three", "four", "five"],
    runCli: async () => {
      calls++;
      return { code: 0, stderr: "", stdout: JSON.stringify({ count: 0, results: [] }) };
    },
  });
  const search = await tools.searchJobs.execute("search", { query: "all roles", location: "", limit: 5 }, undefined, undefined, undefined as never);
  assert.equal(search.details?.count, 0);
  assert.equal(calls, 5);
});

test("non-Japan sources do not invoke Japan fallback queries", async () => {
  let calls = 0;
  const tools = createScrapeTools({
    source: "freehire",
    fallbackQueries: ["Backend Developer"],
    runCli: async () => {
      calls++;
      return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) };
    },
  });
  await tools.searchJobs.execute("search", { query: "all roles", location: "", limit: 5 }, undefined, undefined, undefined as never);
  assert.equal(calls, 1);
});

test("duplicate Japan fallback results are deduped and capped at the requested limit", async () => {
  const calls: string[][] = [];
  const first = { id: "japan-dev:one", title: "Backend Engineer", company: "Example", location: "Japan", url: "https://japan-dev.com/jobs/example/one" };
  const duplicateId = { ...first, title: "Backend Engineer duplicate" };
  const duplicateUrl = { id: "japan-dev:other-id", title: "Backend Engineer same URL", company: "Example", location: "Japan", url: first.url };
  const second = { id: "japan-dev:two", title: "Platform Engineer", company: "Example", location: "Japan", url: "https://japan-dev.com/jobs/example/two" };
  const third = { id: "japan-dev:three", title: "Infrastructure Engineer", company: "Example", location: "Japan", url: "https://japan-dev.com/jobs/example/three" };
  const tools = createScrapeTools({
    source: "japan-dev",
    fallbackQueries: ["first role", "second role"],
    runCli: async (args) => {
      calls.push(args);
      const query = args[args.indexOf("--query") + 1];
      const results = query === "second role" ? [first, duplicateId, duplicateUrl, second, third] : [];
      return { code: 0, stderr: "", stdout: JSON.stringify({ count: results.length, results }) };
    },
  });
  const search = await tools.searchJobs.execute("search", { query: "all roles", location: "", limit: 2 }, undefined, undefined, undefined as never);
  const block = search.content[0];
  if (block.type !== "text") throw new Error("search result was not text");
  const parsed = JSON.parse(block.text) as { count: number; results: Array<{ id: string; url: string }> };
  assert.deepEqual(calls.map((args) => args[args.indexOf("--query") + 1]), ["all roles", "first role", "second role"]);
  assert.equal((parsed as { meta?: { count: number } }).meta?.count, 2);
  assert.deepEqual(parsed.results.map((result) => result.id), [first.id, second.id]);
  assert.equal(parsed.results.length, 2);
  assert.equal(tools.provenance.get(first.id), first.url);
  assert.equal(tools.provenance.get(second.id), second.url);
});

test("searchJobs wraps the vendored FreeHire CLI and records provenance", async () => {
  const job = {
    public_slug: "phase-zero-job-abc123",
    source: "greenhouse",
    external_id: "source:1",
    url: "https://example.test/jobs/1",
    title: "Backend Engineer",
    company: "Example",
    company_slug: "example",
    location: "Remote",
    description: "<p>Build APIs</p>",
    skills: ["typescript"],
    work_mode: "remote",
    regions: ["global"],
    countries: [],
    cities: [],
    posted_at: "2026-08-01T00:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
    enrichment: {},
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/v1/jobs/search")) {
      response.end(JSON.stringify({ data: [job], meta: { total: 1 } }));
      return;
    }
    response.end(JSON.stringify({ data: job }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
  const tools = createScrapeTools({
    env: { FREEHIRE_API_URL: baseUrl },
  });
  try {
    const result = await tools.searchJobs.execute("call", { query: "backend", location: "Remote", limit: 1 }, undefined, undefined, undefined as never);
    const block = result.content[0];
    assert.equal(block.type, "text");
    const parsed = JSON.parse(block.text) as { results: Array<{ id: string; url: string }> };
    assert.equal(parsed.results[0].id, job.public_slug);
    assert.equal(parsed.results[0].url, job.url);
    const detail = await tools.fetchJobDetails.execute("detail", { resultId: job.public_slug }, undefined, undefined, undefined as never);
    const detailBlock = detail.content[0];
    assert.equal(detailBlock.type, "text");
    assert.match(detailBlock.text, /Build APIs/);
    assert.equal(tools.detailDescriptions.get(job.public_slug), "Build APIs");
    assert.doesNotThrow(() => validateScrapeResult({
      jobs: [{ sourceId: job.public_slug, source: "freehire", url: job.url, company: "Example", role: "Backend Engineer", location: "Remote", posting: "Build APIs", score: 81, reason: "fit", strengths: [], gaps: [] }],
    }, new Map([[job.public_slug, job.url]])));
    assert.throws(() => validateScrapeResult({
      jobs: [{ sourceId: job.public_slug, source: "freehire", url: "https://example.test/jobs/fabricated", company: "Example", role: "Backend Engineer", location: "Remote", posting: "Build APIs", score: 81, reason: "fit", strengths: [], gaps: [] }],
    }, new Map([[job.public_slug, job.url]])), /was not returned by a tool/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("LinkedIn search uses the required location and normalizes detail provenance", async () => {
  const calls: string[][] = [];
  const id = "4434178360";
  const url = `https://jp.linkedin.com/jobs/view/software-engineer-${id}`;
  let detailUrl = `https://www.linkedin.com/jobs/view/${id}`;
  const tools = createScrapeTools({
    source: "linkedin",
    runCli: async (args) => {
      calls.push(args);
      if (args[0] === "search") return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 1 }, results: [{ id, title: "Backend Engineer", company: "Example", location: "Tokyo", url }] }) };
      return { code: 0, stderr: "", stdout: JSON.stringify({ id, title: "Backend Engineer", company: "Example", location: "Tokyo", url: detailUrl, description: "Build APIs" }) };
    },
  });
  await assert.rejects(tools.searchJobs.execute("missing-location", { query: "backend", location: "", limit: 1 }, undefined, undefined, undefined as never), /LinkedIn search requires a location/);
  const search = await tools.searchJobs.execute("search", { query: "backend", location: "Tokyo, Japan", limit: 1 }, undefined, undefined, undefined as never);
  assert.deepEqual(calls[0], ["search", "--location", "Tokyo, Japan", "--query", "backend", "--limit", "1", "--format", "json"]);
  const searchBlock = search.content[0];
  if (searchBlock.type !== "text") throw new Error("search result was not text");
  assert.deepEqual(JSON.parse(searchBlock.text), { meta: { count: 1 }, results: [{ id, title: "Backend Engineer", company: "Example", location: "Tokyo", url }] });
  const detail = await tools.fetchJobDetails.execute("detail", { resultId: id }, undefined, undefined, undefined as never);
  assert.deepEqual(calls[1], ["detail", id, "--format", "json"]);
  const detailBlock = detail.content[0];
  if (detailBlock.type !== "text") throw new Error("detail result was not text");
  assert.equal(JSON.parse(detailBlock.text).description, "Build APIs");
  assert.equal(tools.detailDescriptions.get(id), "Build APIs");
  detailUrl = "https://example.com/jobs/view/987654321";
  await assert.rejects(tools.fetchJobDetails.execute("bad-detail", { resultId: id }, undefined, undefined, undefined as never), /LinkedIn detail provenance mismatch/);
  assert.throws(() => validateScrapeResult({ jobs: [{ sourceId: id, source: "freehire", url, company: "Example", role: "Backend Engineer", location: "Tokyo", posting: "Build APIs", score: 81, reason: "fit", strengths: [], gaps: [] }] }, new Map([[id, url]]), 50, "linkedin"), /source must be linkedin/);
});

for (const source of ["tokyodev", "japan-dev"] as const) {
  test(`${source} search normalizes the Japan CLI envelope and verifies URL provenance`, async () => {
    const calls: string[][] = [];
    const id = `${source}:backend-engineer`;
    const url = source === "tokyodev" ? "https://www.tokyodev.com/companies/example/jobs/backend-engineer" : "https://japan-dev.com/jobs/example/backend-engineer";
    let mismatch = false;
    const tools = createScrapeTools({
      source,
      runCli: async (args) => {
        calls.push(args);
        if (args[0] === "search") return { code: 0, stderr: "", stdout: JSON.stringify({ count: 1, results: [{ id, source, title: "Backend Engineer", company: "Example", location: "Tokyo, Japan", url }] }) };
        return { code: 0, stderr: "", stdout: JSON.stringify({ url: mismatch ? "https://example.test/fabricated" : url, title: "Backend Engineer", text: "Build APIs" }) };
      },
    });
    const search = await tools.searchJobs.execute("search", { query: "backend", location: "", limit: 1 }, undefined, undefined, undefined as never);
    assert.deepEqual(calls[0], ["search", "--source", source, "--query", "backend", "--country", "Japan", "--limit", "1", "--format", "json"]);
    const searchBlock = search.content[0];
    if (searchBlock.type !== "text") throw new Error("search result was not text");
    assert.deepEqual(JSON.parse(searchBlock.text), { meta: { count: 1 }, results: [{ id, source, title: "Backend Engineer", company: "Example", location: "Tokyo, Japan", url }] });
    const detail = await tools.fetchJobDetails.execute("detail", { resultId: id }, undefined, undefined, undefined as never);
    assert.deepEqual(calls[1], ["detail", url, "--format", "json"]);
    const detailBlock = detail.content[0];
    if (detailBlock.type !== "text") throw new Error("detail result was not text");
    assert.deepEqual(JSON.parse(detailBlock.text), { id, title: "Backend Engineer", url, description: "Build APIs" });
    assert.equal(tools.detailDescriptions.get(id), "Build APIs");
    mismatch = true;
    await assert.rejects(tools.fetchJobDetails.execute("bad-detail", { resultId: id }, undefined, undefined, undefined as never), new RegExp(`${source === "tokyodev" ? "TokyoDev" : "Japan Dev"} detail provenance mismatch`));
  });
}

test("configured built-in age reaches the CLI and loosened Japan Dev results warn when stale", async () => {
  const calls: string[][] = [];
  const fixture = { id: "japan-dev:old", source: "japan-dev", title: "Backend Engineer", company: "Example", location: "Tokyo", postedDate: "2024-09-01", url: "https://japan-dev.com/jobs/example/old" };
  const runCli = async (args: string[]) => {
    calls.push(args);
    const ageIndex = args.indexOf("--jobage");
    const age = ageIndex >= 0 ? Number(args[ageIndex + 1]) : 45;
    const results = age > 45 ? [fixture] : [];
    return { code: 0, stderr: "", stdout: JSON.stringify({ count: results.length, results }) };
  };
  const strict = createScrapeTools({ source: "japan-dev", runCli });
  const strictResult = await strict.searchJobs.execute("strict", { query: "backend", location: "", limit: 1 }, undefined, undefined, undefined as never);
  const strictBlock = strictResult.content[0];
  if (strictBlock.type !== "text") throw new Error("strict Japan Dev result was not text");
  assert.deepEqual(JSON.parse(strictBlock.text).results, []);
  assert.equal(calls[0].includes("--jobage"), false);

  const loose = createScrapeTools({ source: "japan-dev", maxAgeDays: 3650, now: () => Date.parse("2026-08-18T00:00:00Z"), runCli });
  const looseResult = await loose.searchJobs.execute("loose", { query: "backend", location: "", limit: 1 }, undefined, undefined, undefined as never);
  const looseBlock = looseResult.content[0];
  if (looseBlock.type !== "text") throw new Error("loose Japan Dev result was not text");
  assert.equal(JSON.parse(looseBlock.text).results[0].id, fixture.id);
  assert.deepEqual((loose as any).warnings, ["Japan Dev returned results older than 45 days; verify that postings are still active."]);
  assert.deepEqual(calls[1].slice(-2), ["--jobage", "3650"]);
});

test("validateScrapeResult accepts a regional slug LinkedIn URL for canonical provenance", () => {
  const id = "4443699651";
  const searchUrl = `https://id.linkedin.com/jobs/view/back-end-engineer-${id}`;
  const canonicalUrl = `https://www.linkedin.com/jobs/view/${id}`;
  assert.doesNotThrow(() => validateScrapeResult({
    jobs: [{ sourceId: id, source: "linkedin", url: canonicalUrl, company: "Sea", role: "Back End Engineer", location: "Jakarta", posting: "Backend", score: 80, reason: "fit", strengths: [], gaps: [] }],
  }, new Map([[id, searchUrl]]), 50, "linkedin"));
});

test("validateScrapeResult rejects a different LinkedIn numeric ID", () => {
  const id = "4443699651";
  const searchUrl = `https://id.linkedin.com/jobs/view/back-end-engineer-${id}`;
  const finalUrl = "https://www.linkedin.com/jobs/view/4443699652";
  assert.throws(() => validateScrapeResult({
    jobs: [{ sourceId: id, source: "linkedin", url: finalUrl, company: "Sea", role: "Back End Engineer", location: "Jakarta", posting: "Backend", score: 80, reason: "fit", strengths: [], gaps: [] }],
  }, new Map([[`linkedin\u0000${id}`, searchUrl]]), 50, undefined, ["linkedin", "freehire"]), /was not returned by a tool/);
});

test("validateScrapeResult keeps exact provenance for non-LinkedIn sources", () => {
  const id = "freehire-job-1";
  const searchUrl = "https://jobs.example.test/jobs/freehire-job-1";
  const job = (url: string) => ({
    jobs: [{ sourceId: id, source: "freehire", url, company: "Example", role: "Backend Engineer", location: "Remote", posting: "Build APIs", score: 80, reason: "fit", strengths: [], gaps: [] }],
  });
  const provenance = new Map([[`freehire\u0000${id}`, searchUrl]]);
  assert.doesNotThrow(() => validateScrapeResult(job(searchUrl), provenance, 50, undefined, ["linkedin", "freehire"]));
  assert.throws(() => validateScrapeResult(job(`${searchUrl}?ref=canonical`), provenance, 50, undefined, ["linkedin", "freehire"]), /was not returned by a tool/);
});
