import test from "node:test";
import assert from "node:assert/strict";
import { createLiveSourceScrapeExecutor, createMultiSourceScrapeExecutor, RunManager, sourceQueryRule, type ScrapeContext } from "../src/server/runs.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { createSourceRegistry, type JobSourcePlugin } from "../src/server/source-plugins.js";
import { createScrapeTools, type CliRunner } from "../src/server/scrape.js";
import { openDatabase } from "../src/server/db.js";
import { defaultSourceMaxAgeDays, type JobSource } from "../src/shared.js";
import type { PiSessionLike } from "../src/server/pi.js";

test("Japan-board query prompts omit non-Japan locations while LinkedIn uses locations", () => {
  for (const source of ["tokyodev", "japan-dev"] as const) {
    const japanRule = sourceQueryRule(source);

    assert.match(japanRule, /adapter already fixes country to Japan/i);
    assert.match(japanRule, /roles.*keywords.*skills/i);
    assert.match(japanRule, /one concise role phrase per search/i);
    assert.match(japanRule, /do not concatenate/i);
    assert.match(japanRule, /do not include .*criteria\.locations/i);
    assert.match(japanRule, /post-search evaluation\/scoring/i);
    for (const location of ["Jakarta", "Indonesia"]) assert.doesNotMatch(japanRule, new RegExp(`\\b${location}\\b`, "i"));
  }

  const linkedinRule = sourceQueryRule("linkedin");
  assert.match(linkedinRule, /requires a non-empty location/i);
  assert.match(linkedinRule, /criteria\.locations/i);
});

class FauxSourceSession implements PiSessionLike {
  private listener?: (event: unknown) => void;

  constructor(private readonly output: string, private readonly onPrompt: (prompt: string) => void | Promise<void>) {}

  subscribe(listener: (event: unknown) => void) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  async prompt(prompt: string) {
    await this.onPrompt(prompt);
    this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: this.output } });
  }

  async abort() {}
  dispose() {}
}

const japanJob = {
  id: "japan-dev:backend-one",
  title: "Backend Developer",
  company: "Japan Example",
  location: "Tokyo, Japan",
  url: "https://japan-dev.com/jobs/example/backend-one",
};

type JapanBoardSource = "tokyodev" | "japan-dev";

function sourceContext(source: JapanBoardSource = "japan-dev", roles = ["Backend Developer"]): ScrapeContext {
  return {
    profile: "Backend engineer with TypeScript experience.",
    criteria: { ...defaultCriteria, roles, locations: ["Remote", "Indonesia", "APAC"], maxJobsPerRun: 5 },
    settings: { ...defaultSettings, source, enabledSources: [source], sourceMaxAgeDays: { ...defaultSourceMaxAgeDays, [source]: 99 } },
    signal: new AbortController().signal,
  };
}

function scoredOutput(source: JobSource, job = japanJob, posting = "Build reliable APIs.") {
  return JSON.stringify({ jobs: [{ sourceId: job.id, source, url: job.url, company: job.company, role: job.title, location: job.location, posting, score: 82, reason: "Strong backend fit.", strengths: ["APIs"], gaps: [] }] });
}

function fakeJapanCli(resultForQuery: (query: string) => Array<typeof japanJob>, calls: string[][]) {
  return (async (args) => {
    calls.push(args);
    if (args[0] === "search") {
      const query = args[args.indexOf("--query") + 1];
      const results = resultForQuery(query);
      return { code: 0, stderr: "", stdout: JSON.stringify({ count: results.length, results }) };
    }
    return { code: 0, stderr: "", stdout: JSON.stringify({ url: japanJob.url, title: japanJob.title, text: "Build reliable APIs." }) };
  }) satisfies CliRunner;
}

function testExecutor(options: { source?: JapanBoardSource; roles?: string[]; outputs: string[]; runCli: CliRunner; prompts: string[]; fetchDetails?: boolean }) {
  const source = options.source ?? "japan-dev";
  return createLiveSourceScrapeExecutor({
    loadGuidance: async () => "test guidance",
    createTools: (toolsOptions) => createScrapeTools({ ...toolsOptions, runCli: options.runCli }),
    createSession: async (_settings, tools) => new FauxSourceSession(options.outputs.shift() ?? JSON.stringify({ jobs: [] }), async (prompt) => {
      options.prompts.push(prompt);
      if (options.fetchDetails) await tools.fetchJobDetails.execute("fixture-detail", { resultId: japanJob.id }, undefined, undefined, undefined as never);
    }),
  })(sourceContext(source, options.roles), source);
}

test("non-preflight structured retries share the source search budget", async () => {
  const calls: string[][] = [];
  const sourceRegistry = createSourceRegistry();
  const job = {
    id: "freehire-one",
    title: "Backend Developer",
    company: "FreeHire Example",
    location: "Remote",
    url: "https://freehire.example/jobs/freehire-one",
  };
  const validJob = { sourceId: job.id, source: "freehire", url: job.url, company: job.company, role: job.title, location: job.location, posting: "Build reliable APIs.", score: 82, reason: "Strong backend fit.", strengths: ["APIs"], gaps: [] };
  const outputs = [
    JSON.stringify({ jobs: [{ ...validJob, sourceId: "" }] }),
    JSON.stringify({ jobs: [validJob] }),
  ];
  let toolSetCount = 0;
  const runCli: CliRunner = async args => {
    calls.push(args);
    if (args[0] === "search") return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 1 }, results: [job] }) };
    return { code: 0, stderr: "", stdout: JSON.stringify({ id: job.id, title: job.title, url: job.url, description: "Build reliable APIs." }) };
  };
  const execute = createLiveSourceScrapeExecutor({
    loadGuidance: async () => "test guidance",
    sourceRegistry,
    createTools: toolsOptions => {
      toolSetCount++;
      return createScrapeTools({ ...toolsOptions, runCli });
    },
    createSession: async (_settings, tools, _source, receivedRegistry) => new FauxSourceSession(outputs.shift() ?? JSON.stringify({ jobs: [] }), async () => {
      assert.equal(receivedRegistry, sourceRegistry);
      for (let index = 0; index < 5; index++) {
        await tools.searchJobs.execute(`search-${index}`, { query: `backend-${index}`, location: "Remote", limit: 1 }, undefined, undefined, undefined as never);
      }
    }),
  });
  const context: ScrapeContext = {
    profile: "Backend engineer with TypeScript experience.",
    criteria: { ...defaultCriteria, locations: ["Remote"], maxJobsPerRun: 1 },
    settings: { ...defaultSettings, source: "freehire", enabledSources: ["freehire"], sourceMaxAgeDays: { ...defaultSourceMaxAgeDays, freehire: 99 } },
    signal: new AbortController().signal,
  };

  await assert.rejects(() => execute(context, "freehire"), /at most five times/i);
  assert.equal(toolSetCount, 1);
  assert.equal(calls.filter(args => args[0] === "search").length, 5);
});

test("Japan-board preflight results are included as untrusted source prompt data", async () => {
  const calls: string[][] = [];
  const prompts: string[] = [];
  const output = await testExecutor({
    outputs: [scoredOutput("japan-dev", japanJob, "2026-08-15; metadata only")],
    prompts,
    runCli: fakeJapanCli((query) => query === "Backend Developer" ? [japanJob] : [], calls),
    fetchDetails: true,
  });

  assert.equal((output.result as { jobs: unknown[] }).jobs.length, 1);
  assert.match(prompts[0], /UNTRUSTED TOOL DATA/i);
  assert.match(prompts[0], new RegExp(japanJob.id));
  assert.match(prompts[0], /fetchJobDetails.*every.*preflight/i);
  assert.match(prompts[0], /complete fetched description\/text.*verbatim/i);
  assert.match(prompts[0], /date-only.*metadata-only.*shortened summary/i);
  assert.equal((output.result as { jobs: Array<{ posting: string }> }).jobs[0]?.posting, "Build reliable APIs.");
});

test("Japan-board preflight jobs make an empty model result an invalid bounded attempt", async () => {
  const calls: string[][] = [];
  const prompts: string[] = [];
  await assert.rejects(
    testExecutor({
      outputs: [JSON.stringify({ jobs: [] }), JSON.stringify({ jobs: [] })],
      prompts,
      runCli: fakeJapanCli((query) => query === "Backend Developer" ? [japanJob] : [], calls),
    }),
    /preflight.*jobs|empty/i,
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /prior output failed validation/i);
});

test("Japan-board preflight fallback stays within five searches and preserves provenance", async () => {
  const calls: string[][] = [];
  const prompts: string[] = [];
  const roles = ["one", "two", "three", "four", "five"];
  const output = await testExecutor({
    roles,
    outputs: [scoredOutput("tokyodev")],
    prompts,
    source: "tokyodev",
    runCli: fakeJapanCli((query) => query === "five" ? [japanJob] : [], calls),
  });

  assert.equal(calls.filter((args) => args[0] === "search").length, 5);
  assert.deepEqual(calls.filter((args) => args[0] === "search").map((args) => args[args.indexOf("--query") + 1]), roles);
  assert.equal(output.provenance.get(japanJob.id), japanJob.url);
  assert.ok(calls.filter((args) => args[0] === "search").every((args) => args.includes("--country") && args.includes("Japan")));
});

test("failed final source output does not persist preflight jobs", async () => {
  const calls: string[][] = [];
  const db = openDatabase(":memory:");
  try {
    const execute = createLiveSourceScrapeExecutor({
      loadGuidance: async () => "test guidance",
      createTools: (toolsOptions) => createScrapeTools({ ...toolsOptions, runCli: fakeJapanCli(() => [japanJob], calls) }),
      createSession: async () => new FauxSourceSession(JSON.stringify({ jobs: [] }), () => {}),
    });
    const context = sourceContext();
    const manager = new RunManager(db, createMultiSourceScrapeExecutor(execute), async () => ({ profile: context.profile, criteria: context.criteria, settings: context.settings }));
    const runId = await manager.start();
    let run = manager.get(runId) as unknown as { status?: string } | undefined;
    for (let attempt = 0; attempt < 50 && run?.status === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      run = manager.get(runId) as unknown as { status?: string } | undefined;
    }
    assert.equal(run?.status, "failed");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});
test("RunManager preserves custom source registries through final validation", async () => {
  const fixtureJob = {
    id: "fixture-one",
    title: "Backend Developer",
    company: "Fixture Co",
    location: "Remote",
    url: "https://fixture.example/jobs/fixture-one",
  };
  const plugin: JobSourcePlugin = {
    manifest: {
      id: "fixture",
      label: "Fixture",
      version: "1.0.0",
      capabilities: { search: true, detail: false, pagination: false, location: true, freshness: false, remote: true, activeStatus: false },
      policy: { maxRequestsPerRun: 10, maxConcurrentRequests: 1, timeoutMs: 1_000, minimumDelayMs: 0 },
      guidance: { strengths: ["Fixture source."], caveats: ["Fixture data is local."], query: "Use the fixture query." },
    },
    search: async (_request, context) => context.request(async () => ({ meta: { count: 1 }, results: [fixtureJob] })),
  };
  const registry = createSourceRegistry([plugin]);
  const context: Omit<ScrapeContext, "signal"> = {
    profile: "Backend engineer with TypeScript experience.",
    criteria: { ...defaultCriteria, roles: ["Backend Developer"], locations: ["Remote"], maxJobsPerRun: 1 },
    settings: { ...defaultSettings, source: "freehire", enabledSources: ["fixture"] },
  };
  const execute = createLiveSourceScrapeExecutor({
    sourceRegistry: registry,
    loadGuidance: async () => "test guidance",
    createSession: async (_settings, tools) => new FauxSourceSession(scoredOutput("fixture", fixtureJob), async () => {
      await tools.searchJobs.execute("fixture-search", { query: "Backend Developer", location: "Remote", limit: 1 }, undefined, undefined, undefined as never);
    }),
  });
  const db = openDatabase(":memory:");
  try {
    const manager = new RunManager(db, createMultiSourceScrapeExecutor(execute, registry), async () => context);
    const runId = await manager.start();
    const readRun = () => {
      const value = manager.get(runId);
      if (!value || typeof value !== "object") return undefined;
      const status = "status" in value && typeof value.status === "string" ? value.status : undefined;
      const summary = "summary" in value && value.summary && typeof value.summary === "object" ? value.summary : undefined;
      const jobsFound = summary && "jobsFound" in summary && typeof summary.jobsFound === "number" ? summary.jobsFound : undefined;
      return { status, jobsFound };
    };
    let run = readRun();
    for (let attempt = 0; attempt < 100 && run?.status === "running"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2));
      run = readRun();
    }
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.jobsFound, 1);
    const row = db.prepare("SELECT COUNT(*) AS count FROM jobs").get();
    if (!row || typeof row !== "object" || !("count" in row) || typeof row.count !== "number") throw new Error("job count query returned an invalid row");
    assert.equal(row.count, 1);
  } finally {
    db.close();
  }
});
