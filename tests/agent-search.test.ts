import test from "node:test";
import assert from "node:assert/strict";
import { AllSourcesFailedError, createAgentSearchExecutor, type ScrapeContext } from "../src/server/runs.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { createScrapeTools, type ScrapeTools, type ScrapeToolsOptions } from "../src/server/scrape.js";
import { createAgentSearchTools, type AgentSearchTools } from "../src/server/search/tools.js";
import { AgentSearchState, SearchBudgetExceededError, SearchCoverageError, SearchNotFinishedError, includesCriterion, passesHardSearchConstraints, resolveSearchBudget } from "../src/server/search/state.js";
import type { PiSessionLike } from "../src/server/pi.js";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { jobSourceKeys, type JobSource } from "../src/shared.js";


function textResult(value: unknown) {
  const content = (value as { content: Array<{ type: string; text?: string }> }).content;
  const block = content.find((item) => item.type === "text");
  if (!block?.text) throw new Error("tool returned no text");
  return JSON.parse(block.text) as Record<string, any>;
}

function sourceFactory(runCli: (args: string[]) => Promise<{ code: number; stderr: string; stdout: string }>) {
  return (options: ScrapeToolsOptions) => createScrapeTools({ ...options, runCli });
}

function makeAgentTools(runCli: (args: string[]) => Promise<{ code: number; stderr: string; stdout: string }>, budget: Record<string, number> = {}) {
  const state = new AgentSearchState({ goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] }, budget });
  return createAgentSearchTools({ state, sourceTools: new Map([["freehire", createScrapeTools({ source: "freehire", runCli })]]) });
}
test("default search preferences stay optional for profile-led discovery", () => {
  assert.deepEqual(defaultCriteria.roles, []);
  assert.deepEqual(defaultCriteria.locations, []);
  assert.deepEqual(defaultCriteria.keywords, []);
  assert.deepEqual(defaultCriteria.employmentTypes, []);
});

const detail = (id: string, url: string) => ({ id, title: "Backend Engineer", url, description: "Full posting for the selected job." });
const sourceFloorHit = (source: (typeof jobSourceKeys)[number], id: string) => ({
  source,
  sourceId: id,
  title: "Engineer",
  url: `https://jobs.example.test/${source}/${id}`,
});


test("agent search state supports adaptive discovery, selective detail, inspection, and explicit finish", async () => {
  const url = "https://jobs.example.test/backend-one";
  let searchCalls = 0;
  const tools = makeAgentTools(async (args) => args[0] === "search"
    ? (++searchCalls === 1
      ? { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 2 }, results: [
        { id: "job-1", title: "Backend Engineer", company: "Example", location: "Remote", url },
        { id: "job-2", title: "Platform Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/platform-two" },
      ] }) }
      : { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 1 }, results: [
        { id: "job-3", title: "Infrastructure Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/infrastructure-three" },
      ] }) })
    : { code: 0, stderr: "", stdout: JSON.stringify(detail("job-1", url)) }, { maxSearchCalls: 3, maxDetailCalls: 1, maxTotalResults: 3 });

  const search = await tools.searchJobs.execute("search-1", { source: "freehire", query: "backend", location: "", limit: 5 }, undefined, undefined, undefined as never);
  const discovered = textResult(search);
  assert.equal((discovered.hits as unknown[]).length, 2);
  assert.equal(JSON.stringify(discovered).includes("score"), false);

  const stateAfterSearch = textResult(await tools.inspectSearchState.execute("inspect-1", {}, undefined, undefined, undefined as never));
  assert.deepEqual({ maxSearchCalls: stateAfterSearch.remaining.maxSearchCalls, maxDetailCalls: stateAfterSearch.remaining.maxDetailCalls, maxTotalResults: stateAfterSearch.remaining.maxTotalResults }, { maxSearchCalls: 2, maxDetailCalls: 1, maxTotalResults: 1 });
  assert.ok(stateAfterSearch.remaining.maxRunDurationMs > 0 && stateAfterSearch.remaining.maxRunDurationMs <= 120000);
  assert.equal(stateAfterSearch.uniqueCount, 2);

  const searchAgain = await tools.searchJobs.execute("search-2", { source: "freehire", query: "infrastructure", location: "", limit: 5 }, undefined, undefined, undefined as never);
  assert.equal((textResult(searchAgain).hits as unknown[]).length, 1);
  const stateAfterSecondSearch = textResult(await tools.inspectSearchState.execute("inspect-2", {}, undefined, undefined, undefined as never));
  assert.equal(stateAfterSecondSearch.uniqueCount, 3);
  assert.equal(stateAfterSecondSearch.remaining.maxSearchCalls, 1);
  assert.equal(stateAfterSecondSearch.remaining.maxTotalResults, 0);

  const fetched = await tools.fetchJobDetails.execute("detail-1", { source: "freehire", resultId: "job-1" }, undefined, undefined, undefined as never);
  assert.match(JSON.stringify(textResult(fetched)), /Full posting/);
  assert.equal(tools.detailDescriptions.get("freehire\u0000job-1"), "Full posting for the selected job.");
  const stateAfterDetail = textResult(await tools.inspectSearchState.execute("inspect-3", {}, undefined, undefined, undefined as never));
  assert.equal(stateAfterDetail.enrichedCount, 1);
  assert.equal(stateAfterDetail.remaining.maxDetailCalls, 0);

  const finished = textResult(await tools.finishSearch.execute("finish-1", { reason: "Two relevant candidates discovered; one was enriched.", unresolvedGoals: ["Could not verify compensation"] }, undefined, undefined, undefined as never));
  assert.equal(finished.finished, true);
  assert.equal(finished.state.remaining.maxSearchCalls, 1);
  assert.deepEqual(finished.termination.unresolvedGoals, ["Could not verify compensation"]);
  assert.equal(tools.provenance.get("freehire\u0000job-1"), url);
});

test("agent tools reject fabricated provenance and enforce global budgets", async () => {
  const tools = makeAgentTools(async (args) => args[0] === "search"
    ? { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 2 }, results: [
      { id: "job-1", title: "Engineer", company: null, location: null, url: "https://jobs.example.test/one" },
      { id: "job-2", title: "Engineer", company: null, location: null, url: "https://jobs.example.test/two" },
    ] }) }
    : { code: 0, stderr: "", stdout: JSON.stringify(detail("job-1", "https://jobs.example.test/one")) }, { maxSearchCalls: 1, maxDetailCalls: 1, maxTotalResults: 2 });

  await assert.rejects(tools.fetchJobDetails.execute("fake", { source: "freehire", resultId: "fabricated" }, undefined, undefined, undefined as never), /was not returned/);
  await tools.searchJobs.execute("search", { source: "freehire", query: "engineer", location: "", limit: 2 }, undefined, undefined, undefined as never);
  await assert.rejects(tools.searchJobs.execute("over", { source: "freehire", query: "engineer", location: "", limit: 1 }, undefined, undefined, undefined as never), SearchBudgetExceededError);
  await tools.fetchJobDetails.execute("detail", { source: "freehire", resultId: "job-1" }, undefined, undefined, undefined as never);
  await assert.rejects(tools.fetchJobDetails.execute("over-detail", { source: "freehire", resultId: "job-2" }, undefined, undefined, undefined as never), SearchBudgetExceededError);
});

test("expired reservations reject without granting provenance and record a budget event", async () => {
  let now = 0;
  const events: Array<{ type: string; payload?: unknown }> = [];
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] },
    budget: { maxRunDurationMs: 10 },
    now: () => now,
    runId: "run-budget",
    trajectory: (_runId, event) => { events.push({ type: event.type, payload: event.payload }); },
  });
  const tools = createAgentSearchTools({
    state,
    sourceTools: new Map([["freehire", createScrapeTools({
      source: "freehire",
      runCli: async () => {
        now = 11;
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 1 }, results: [{ id: "job-1", title: "Engineer", company: null, location: null, url: "https://jobs.example.test/one" }] }) };
      },
    })]]),
  });
  await assert.rejects(tools.searchJobs.execute("expired", { source: "freehire", query: "engineer", location: "", limit: 1 }, undefined, undefined, undefined as never), SearchBudgetExceededError);
  assert.equal(state.provenance.size, 0);
  assert.equal(state.snapshot().attempts.at(-1)?.status, "rejected");
  const rejection = events.find((event) => event.type === "search_budget_rejected");
  assert.equal((rejection?.payload as { reason?: string })?.reason, "maxRunDurationMs");
});

test("same-run provenance is qualified by source and trajectory records the harness lifecycle", async () => {
  const events: Array<{ type: string; payload?: unknown }> = [];
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire", "linkedin"] },
    runId: "run-1",
    trajectory: (_runId, event) => { events.push({ type: event.type, payload: event.payload }); },
  });
  const adapter = (id: string, url: string) => createScrapeTools({
    source: id === "freehire-job" ? "freehire" : "linkedin",
    runCli: async (args) => args[0] === "search"
      ? { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 1 }, results: [{ id, title: "Engineer", company: "Example", location: "Remote", url }] }) }
      : { code: 0, stderr: "", stdout: JSON.stringify(detail(id, url)) },
  });
  const tools = createAgentSearchTools(state, new Map([
    ["freehire", adapter("freehire-job", "https://jobs.example.test/freehire")],
    ["linkedin", adapter("partner-job", "https://jobs.example.test/partner")],
  ]));
  await tools.searchJobs.execute("freehire-search", { source: "freehire", query: "engineer", location: "", limit: 1 }, undefined, undefined, undefined as never);
  await assert.rejects(tools.fetchJobDetails.execute("wrong-source", { source: "linkedin", resultId: "freehire-job" }, undefined, undefined, undefined as never), /was not returned/);
  await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never);
  const unavailable = state.reserveSearch({ source: "linkedin", query: "engineer", location: "", limit: 1 });
  state.failSearch(unavailable, new Error("provider unavailable"));
  await tools.finishSearch.execute("finish", { reason: "Enough evidence collected." }, undefined, undefined, undefined as never);
  assert.deepEqual(tools.provenance.get("freehire\u0000freehire-job"), "https://jobs.example.test/freehire");
  assert.ok(events.some((event) => event.type === "search_started"));
  assert.ok(events.some((event) => event.type === "search_completed"));
  const inspected = events.find((event) => event.type === "search_state_inspected");
  const inspectPayload = inspected?.payload && typeof inspected.payload === "object" ? inspected.payload as { marginalUtility?: unknown } : null;
  assert.ok(inspectPayload && Object.prototype.hasOwnProperty.call(inspectPayload, "marginalUtility"));
  assert.deepEqual(inspectPayload?.marginalUtility, state.snapshot().marginalUtility);
  assert.ok(events.some((event) => event.type === "search_finished"));
});

test("search state records adaptive yield, duplicate provenance, coverage, and termination categories", () => {
  let now = 0;
  const state = new AgentSearchState({
    goal: {
      criteria: { ...defaultCriteria, roles: ["Backend Engineer"], locations: ["Remote"], keywords: ["TypeScript"], remoteOnly: true, excludeKeywords: ["PHP"] },
      enabledSources: ["freehire", "linkedin"],
    },
    budget: { maxSearchCalls: 5, maxTotalResults: 10 },
    now: () => now,
  });
  assert.equal(state.snapshot().marginalUtility.status, "unmeasured");
  const irrelevant = { source: "freehire", sourceId: "php-1", title: "PHP Developer", company: "Legacy", location: "Berlin", url: "https://jobs.example.test/php-1" };
  for (let index = 0; index < 3; index += 1) {
    const reservation = state.reserveSearch({ source: "freehire", query: "backend", location: "Remote", limit: 1 });
    now += 10;
    state.completeSearch(reservation, [irrelevant]);
  }
  const useful = state.reserveSearch({ source: "linkedin", query: "backend typescript", location: "Remote", limit: 1 });
  now += 10;
  state.completeSearch(useful, [{ source: "linkedin", sourceId: "ts-1", title: "Backend Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/ts-1" }]);
  const beforeDetail = state.snapshot();
  assert.equal(beforeDetail.coverage["keyword:typescript"], "unknown");
  const usefulDetail = state.reserveDetail({ source: "linkedin", resultId: "ts-1" });
  now += 10;
  state.completeDetail(usefulDetail, "Backend Engineer using TypeScript.");
  const snapshot = state.snapshot();
  assert.equal(snapshot.attempts[0]?.id, "search-1");
  assert.equal(snapshot.attempts[1]?.repeatCount, 1);
  assert.equal(snapshot.attempts[1]?.duplicateCount, 1);
  assert.equal(snapshot.attempts[1]?.uniqueResultCount, 0);
  assert.equal(snapshot.attempts[3]?.source, "linkedin");
  assert.equal(snapshot.coverageSufficient, true);
  assert.equal(snapshot.coverage["role:backend engineer"], "medium");
  assert.equal(snapshot.coverage["location:remote"], "medium");
  assert.equal(snapshot.coverage["keyword:typescript"], "medium");
  assert.equal(snapshot.marginalUtility.repeatedZeroYieldSearches, 2);
  assert.match(snapshot.marginalUtility.recommendation, /Avoid repeating/);
  const freehireStats = snapshot.sourceStats.freehire;
  assert.deepEqual({
    searches: freehireStats.searches,
    uniqueHits: freehireStats.uniqueHits,
    promisingHits: freehireStats.promisingHits,
    averageYield: freehireStats.averageYield,
    lastYield: freehireStats.lastYield,
    pagesVisited: freehireStats.pagesVisited,
  }, { searches: 3, uniqueHits: 1, promisingHits: 0, averageYield: 1 / 3, lastYield: 0, pagesVisited: [] });
  assert.equal(freehireStats.queryHistory.length, 3);
  state.finish("Coverage is sufficient.", [], "coverage_sufficient");
  assert.equal(state.assertFinished()?.reasonCategory, "coverage_sufficient");
  const empty = new AgentSearchState({ goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] } });
  const failedEmpty = empty.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 1 });
  empty.failSearch(failedEmpty, new Error("source unavailable"));
  empty.finish("No relevant jobs found.");
  assert.equal(empty.assertFinished()?.reasonCategory, "no_results");
});
test("search telemetry separates raw hits from rows consumed by the result budget", () => {
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 1, maxTotalResults: 2 },
  });
  const reservation = state.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 5 });
  state.completeSearch(reservation, [
    { source: "freehire", sourceId: "job-1", title: "Engineer", url: "https://jobs.example.test/job-1" },
    { source: "freehire", sourceId: "job-2", title: "Engineer", url: "https://jobs.example.test/job-2" },
    { source: "freehire", sourceId: "job-3", title: "Engineer", url: "https://jobs.example.test/job-3" },
  ]);
  const snapshot = state.snapshot();
  const attempt = snapshot.attempts[0]!;
  const stats = snapshot.sourceStats.freehire;
  assert.equal(snapshot.discoveredCount, 2);
  assert.equal(attempt.resultCount, 2);
  assert.equal(attempt.rawHits, 3);
  assert.equal(attempt.uniqueResultCount, 2);
  assert.equal(attempt.duplicateCount, 0);
  assert.equal(stats.rawHits, 3);
  assert.equal(stats.duplicateRate, 0);
  assert.equal(stats.queryHistory[0]?.returnedHits, 2);
  assert.equal(stats.queryHistory[0]?.rawHits, 3);
  assert.equal(snapshot.paths[0]?.raw, 3);
});

test("search accounting includes adapter and global duplicates exactly once across queries, pages, and sources", async () => {
  const sharedUrl = "https://jobs.example.test/shared";
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire", "linkedin"] },
    budget: { maxSearchCalls: 3, maxTotalResults: 10 },
  });
  const sourceTools = {
    freehire: createScrapeTools({
      source: "freehire",
      runCli: async args => {
        if (args[0] !== "search") return { code: 0, stderr: "", stdout: "{}" };
        const pageIndex = args.indexOf("--page");
        const page = pageIndex === -1 ? 1 : Number(args[pageIndex + 1]);
        const results = page === 1
          ? [
            { id: "job-shared", title: "Engineer", company: "Example", location: "Remote", url: sharedUrl },
            { id: "job-shared", title: "Duplicate ID", company: "Example", location: "Remote", url: "https://jobs.example.test/duplicate-id" },
            { id: "job-2", title: "Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/job-2" },
          ]
          : [
            { id: "page-two-shared", title: "Engineer", company: "Example", location: "Remote", url: sharedUrl },
            { id: "job-3", title: "Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/job-3" },
          ];
        const meta = { count: 99, rawHits: page === 1 ? 4 : 2, duplicatesRemoved: page === 1 ? 1 : 0, page, total: 10 };
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta, results }) };
      },
    }),
    linkedin: createScrapeTools({
      source: "linkedin",
      runCli: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          meta: { count: 99 },
          results: [
            { id: "linkedin-shared", title: "Engineer", company: "Example", location: "Remote", url: sharedUrl },
            { id: "job-4", title: "Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/job-4" },
          ],
        }),
      }),
    }),
  };
  const tools = createAgentSearchTools(state, sourceTools);
  await tools.searchJobs.execute("freehire-page-1", {
    source: "freehire", query: "backend", location: "Remote", limit: 5,
  }, undefined, undefined, undefined as never);
  await tools.searchJobs.execute("freehire-page-2", {
    source: "freehire", query: "backend", location: "Remote", limit: 5, page: 2,
  }, undefined, undefined, undefined as never);
  await tools.searchJobs.execute("linkedin-query", {
    source: "linkedin", query: "backend", location: "Remote", limit: 5,
  }, undefined, undefined, undefined as never);

  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.attempts.map(({ resultCount, rawHits, duplicateCount }) => [resultCount, rawHits, duplicateCount]), [
    [2, 4, 2],
    [2, 2, 1],
    [2, 2, 1],
  ]);
  assert.equal(snapshot.discoveredCount, 6);
  assert.equal(snapshot.uniqueCount, 4);
  assert.equal(snapshot.sourceStats.freehire.rawHits, 6);
  assert.equal(snapshot.sourceStats.freehire.duplicateCount, 3);
  assert.equal(snapshot.sourceStats.linkedin.rawHits, 2);
  assert.equal(snapshot.sourceStats.linkedin.duplicateCount, 1);
  assert.deepEqual(snapshot.sourceStats.freehire.queryHistory.map(({ rawHits, returnedHits }) => [rawHits, returnedHits]), [[4, 2], [2, 2]]);
  assert.deepEqual(
    snapshot.paths.filter(path => path.source === "freehire").map(({ page, raw }) => [page, raw]),
    [[1, 4], [2, 2]],
  );
  assert.equal(state.provenance.get("freehire\u0000job-shared"), sharedUrl);
  assert.equal(state.provenance.has("freehire\u0000page-two-shared"), false);
  assert.equal(state.provenance.has("linkedin\u0000linkedin-shared"), false);
});

test("search completion respects reservation and remaining result limits", () => {
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 2, maxTotalResults: 3 },
  });
  const first = state.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 2 });
  const second = state.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 2 });
  state.completeSearch(first, Array.from({ length: 25 }, (_, index) => sourceFloorHit("freehire", `first-${index}`)));
  state.completeSearch(second, Array.from({ length: 25 }, (_, index) => sourceFloorHit("freehire", `second-${index}`)));
  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.attempts.map(attempt => attempt.resultCount), [2, 1]);
  assert.equal(snapshot.discoveredCount, 3);
  assert.equal(snapshot.remaining.maxTotalResults, 0);
});



test("finish requires every enabled source or an explicit unavailable-source exception", () => {
  const events: Array<{ type: string; payload?: unknown }> = [];
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire", "linkedin"] },
    budget: { maxSearchCalls: 4, maxTotalResults: 4 },
    runId: "coverage-test",
    trajectory: (_runId, event) => events.push(event),
  });
  const first = state.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 1 });
  state.completeSearch(first, []);
  assert.throws(
    () => state.finish("The budget is exhausted.", [], "budget_exhausted"),
    /budget_exhausted is valid only/,
  );
  assert.equal(state.termination, null);
  const categoryRejection = events.at(-1);
  assert.equal(categoryRejection?.type, "search_finish_rejected");
  assert.equal((categoryRejection?.payload as { reasonCategory?: unknown }).reasonCategory, "budget_exhausted");
  assert.throws(
    () => state.finish("One source returned enough candidates.", [], "candidates_sufficient"),
    error => error instanceof SearchCoverageError && error.unsearchedSources.length === 1 && error.unsearchedSources[0] === "linkedin",
  );
  assert.equal(state.termination, null);
  const inferred = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 4, maxTotalResults: 4 },
  });
  const inferredSearch = inferred.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 1 });
  inferred.completeSearch(inferredSearch, []);
  inferred.finish("The limit of useful candidates/searches has been reached.");
  assert.equal(inferred.assertFinished()?.reasonCategory, "other");
  const available = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 4, maxTotalResults: 4 },
  });
  const availableSearch = available.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 1 });
  available.completeSearch(availableSearch, []);
  available.finish("The budget remains for another pass.");
  assert.equal(available.assertFinished()?.reasonCategory, "other");
  const unavailable = state.reserveSearch({ source: "linkedin", query: "engineer", location: "", limit: 1 });
  state.failSearch(unavailable, new Error("provider unavailable"));
  state.finish("No usable source data remained.", [], "no_results");
  assert.deepEqual(state.snapshot().sourceCoverage, {
    required: ["freehire", "linkedin"],
    searched: ["freehire", "linkedin"],
    unavailable: ["linkedin"],
    unsearched: [],
  });
});

test("unicode criteria keep punctuation and reject empty normalized criteria", () => {
  assert.equal(includesCriterion("C++ 日本語", "C#"), false);
  assert.equal(includesCriterion("C++ 日本語", ""), false);
  const state = new AgentSearchState({
    goal: {
      criteria: { ...defaultCriteria, roles: ["Ｃ＋＋"], keywords: ["C#", "日本語"] },
      enabledSources: ["freehire"],
    },
  });
  const reservation = state.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 1 });
  state.completeSearch(reservation, [{
    source: "freehire",
    sourceId: "cpp-1",
    title: "C++ Engineer",
    company: "日本語",
    location: "東京",
    url: "https://jobs.example.test/cpp-1",
  }]);
  const snapshot = state.snapshot();
  assert.equal(snapshot.coverage["role:c++"], "medium");
  assert.equal(snapshot.coverage["keyword:c#"], "unknown");
  assert.equal(snapshot.coverage["keyword:日本語"], "unknown");
  assert.equal(snapshot.coverage["keyword:c"], undefined);
});
test("criterion matching respects token boundaries and technology punctuation", () => {
  assert.equal(includesCriterion("Django Developer", "Go"), false);
  assert.equal(includesCriterion("JavaScript Engineer", "Java"), false);
  assert.equal(includesCriterion("Retail Platform", "AI"), false);
  assert.equal(includesCriterion("C++ Engineer", "C++"), true);
  assert.equal(includesCriterion("C# Engineer", "C#"), true);
  assert.equal(includesCriterion("Node.js Engineer", "Node.js"), true);
  assert.equal(includesCriterion(".NET Engineer", ".NET"), true);
});

test("hard constraints scan full postings and reject negative remote labels", () => {
  const criteria = { ...defaultCriteria, remoteOnly: true, excludeKeywords: ["PHP"] };
  const longPosting = `${"x".repeat(32_001)} PHP`;
  assert.equal(passesHardSearchConstraints({ title: "Backend Engineer", company: "Example", location: "Remote" }, criteria, longPosting), false);
  assert.equal(passesHardSearchConstraints({ title: "Backend Engineer", company: "Example", location: "Not remote" }, { ...defaultCriteria, remoteOnly: true }), false);
  assert.equal(passesHardSearchConstraints({ title: "Backend Engineer", company: "Example", location: "non-remote" }, { ...defaultCriteria, remoteOnly: true }), false);
  assert.equal(passesHardSearchConstraints({ title: "Backend Engineer", company: "Example", location: "Hybrid remote" }, { ...defaultCriteria, remoteOnly: true }), false);
});

test("soft role and location preferences remain visible in coverage", () => {
  const state = new AgentSearchState({
    goal: {
      criteria: { ...defaultCriteria, roles: ["Backend Engineer"], locations: ["Japan"] },
      enabledSources: ["freehire"],
    },
  });
  const reservation = state.reserveSearch({ source: "freehire", query: "role", location: "Singapore", limit: 1 });
  state.completeSearch(reservation, [{
    source: "freehire",
    sourceId: "product-1",
    title: "Product Manager",
    location: "Singapore",
    url: "https://jobs.example.test/product-1",
  }]);
  const detailReservation = state.reserveDetail({ source: "freehire", resultId: "product-1" });
  state.completeDetail(detailReservation, "Backend Engineer collaboration across Japan.");
  const snapshot = state.snapshot();
  assert.equal(snapshot.coverage["role:backend engineer"], "weak");
  assert.equal(snapshot.coverage["location:japan"], "weak");
  assert.equal(snapshot.coverageSufficient, false);
  assert.equal(snapshot.sourceStats.freehire.promisingJobs, 1);
});

test("long detail evidence remains searchable beyond the criterion bound", () => {
  const state = new AgentSearchState({
    goal: {
      criteria: { ...defaultCriteria, roles: ["Backend Engineer"], keywords: ["Java"] },
      enabledSources: ["freehire"],
    },
  });
  const reservation = state.reserveSearch({ source: "freehire", query: "backend", location: "", limit: 1 });
  state.completeSearch(reservation, [{
    source: "freehire",
    sourceId: "long-1",
    title: "Backend Engineer",
    location: "Remote",
    url: "https://jobs.example.test/long-1",
  }]);
  const detailReservation = state.reserveDetail({ source: "freehire", resultId: "long-1" });
  state.completeDetail(detailReservation, `${"x".repeat(500)} Java Spring Boot Kubernetes`);
  const snapshot = state.snapshot();
  assert.equal(snapshot.coverage["keyword:java"], "medium");
  assert.equal(snapshot.coverageSufficient, true);
});

test("keyword coverage stays unknown until every promising candidate has detail", () => {
  const state = new AgentSearchState({
    goal: {
      criteria: { ...defaultCriteria, roles: ["Backend Engineer"], keywords: ["Java"] },
      enabledSources: ["freehire"],
    },
  });
  const reservation = state.reserveSearch({ source: "freehire", query: "backend", location: "", limit: 2 });
  state.completeSearch(reservation, [
    { source: "freehire", sourceId: "partial-1", title: "Backend Engineer", location: "Remote", url: "https://jobs.example.test/partial-1" },
    { source: "freehire", sourceId: "partial-2", title: "Backend Engineer", location: "Remote", url: "https://jobs.example.test/partial-2" },
  ]);
  const firstDetail = state.reserveDetail({ source: "freehire", resultId: "partial-1" });
  state.completeDetail(firstDetail, "Backend Engineer using Go.");
  assert.equal(state.snapshot().coverage["keyword:java"], "unknown");
  const secondDetail = state.reserveDetail({ source: "freehire", resultId: "partial-2" });
  state.completeDetail(secondDetail, "Backend Engineer using Go.");
  assert.equal(state.snapshot().coverage["keyword:java"], "weak");
});

test("coverage reports each preference dimension for discovery candidates", () => {
  const state = new AgentSearchState({
    goal: {
      criteria: {
        ...defaultCriteria,
        roles: ["Backend Engineer", "Platform Engineer"],
        locations: ["Japan", "Singapore"],
      },
      enabledSources: ["freehire"],
    },
  });
  const reservation = state.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 3 });
  state.completeSearch(reservation, [
    { source: "freehire", sourceId: "a", title: "Backend Engineer", location: "Berlin", url: "https://jobs.example.test/a" },
    { source: "freehire", sourceId: "b", title: "Product Manager", location: "Japan", url: "https://jobs.example.test/b" },
    { source: "freehire", sourceId: "c", title: "Platform Engineer", location: "Singapore", url: "https://jobs.example.test/c" },
  ]);
  const snapshot = state.snapshot();
  assert.equal(snapshot.coverage["role:backend engineer"], "medium");
  assert.equal(snapshot.coverage["role:platform engineer"], "medium");
  assert.equal(snapshot.coverage["location:japan"], "medium");
  assert.equal(snapshot.coverage["location:singapore"], "medium");
  assert.equal(snapshot.coverageSufficient, true);
});


test("keyword coverage remains a preference signal after detail", () => {
  const state = new AgentSearchState({
    goal: {
      criteria: { ...defaultCriteria, roles: ["Backend Engineer"], keywords: ["TypeScript"] },
      enabledSources: ["freehire"],
    },
  });
  const reservation = state.reserveSearch({ source: "freehire", query: "backend", location: "", limit: 1 });
  state.completeSearch(reservation, [{
    source: "freehire",
    sourceId: "backend-1",
    title: "Backend Engineer",
    location: "Remote",
    url: "https://jobs.example.test/backend-1",
  }]);
  assert.equal(state.snapshot().attempts[0]?.promisingResultCount, 1);
  const detailReservation = state.reserveDetail({ source: "freehire", resultId: "backend-1" });
  state.completeDetail(detailReservation, "Backend Engineer using Go.");
  assert.equal(state.snapshot().attempts[0]?.promisingResultCount, 1);
  assert.equal(state.snapshot().sourceStats.freehire.promisingJobs, 1);
  assert.equal(state.snapshot().coverage["keyword:typescript"], "weak");
  const refreshedDetail = state.reserveDetail({ source: "freehire", resultId: "backend-1" });
  state.completeDetail(refreshedDetail, "Backend Engineer using TypeScript.");
  assert.equal(state.snapshot().attempts[0]?.promisingResultCount, 1);
  assert.equal(state.snapshot().sourceStats.freehire.promisingJobs, 1);
  assert.equal(state.snapshot().coverage["keyword:typescript"], "medium");
  assert.equal(state.snapshot().coverageSufficient, true);
});

test("detail evidence updates promising hit counters", () => {
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria, excludeKeywords: ["PHP"] }, enabledSources: ["freehire"] },
  });
  const search = state.reserveSearch({ source: "freehire", query: "backend", location: "", limit: 1 });
  state.completeSearch(search, [{
    source: "freehire",
    sourceId: "backend-php-detail",
    title: "Backend Engineer",
    company: "Example",
    location: "Remote",
    url: "https://jobs.example.test/backend-php-detail",
  }]);
  assert.equal(state.snapshot().sourceStats.freehire.promisingHits, 1);
  const detail = state.reserveDetail({ source: "freehire", resultId: "backend-php-detail" });
  state.completeDetail(detail, "PHP Developer role.");
  assert.equal(state.snapshot().attempts[0]?.promisingResultCount, 0);
  assert.equal(state.snapshot().sourceStats.freehire.promisingJobs, 0);
  assert.equal(state.snapshot().sourceStats.freehire.promisingHits, 0);
});
test("marginal utility counts profile-compatible candidates", () => {
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria, roles: ["Backend Engineer"] }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 3, maxTotalResults: 10 },
  });
  const reservation = state.reserveSearch({ source: "freehire", query: "engineer", location: "", limit: 2 });
  state.completeSearch(reservation, [
    { source: "freehire", sourceId: "php-1", title: "PHP Developer", location: "Remote", url: "https://jobs.example.test/php-1" },
    { source: "freehire", sourceId: "java-1", title: "Java Developer", location: "Remote", url: "https://jobs.example.test/java-1" },
  ]);
  const marginal = state.snapshot().marginalUtility;
  assert.equal(marginal.recentUniqueJobs, 2);
  assert.equal(marginal.recentPromisingJobs, 2);
  assert.equal(marginal.score, 2);
  assert.equal(marginal.status, "high");
});

test("search tools reject an unconfigured enabled source before adapter execution", async () => {
  const state = new AgentSearchState({ goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire", "linkedin"] } });
  let calls = 0;
  const tools = createAgentSearchTools(state, new Map([["freehire", createScrapeTools({ source: "freehire", runCli: async () => { calls += 1; return { code: 0, stderr: "", stdout: "{}" }; } })]]));
  await assert.rejects(tools.searchJobs.execute("missing-source", { source: "linkedin", query: "backend", location: "Remote", limit: 1 }, undefined, undefined, undefined as never), /No search adapter is configured/);
  assert.equal(calls, 0);
  const failed = state.reserveSearch({ source: "freehire", query: "backend", location: "Remote", limit: 1 });
  state.failSearch(failed, new Error("source unavailable"));
  assert.equal(state.snapshot().sourceStats.freehire.errors, 1);
  assert.equal(state.snapshot().sourceStats.linkedin.errors, 0);
});

test("same goal trajectories honor source floors from inspected state", async () => {
  class FakeSession implements PiSessionLike {
    subscribe() { return () => {}; }
    async prompt() {}
    async abort() {}
    dispose() {}
  }

  let activeRunId = "";
  let currentTools: AgentSearchTools | undefined;
  const calls: string[] = [];
  const createSourceTools = (options: ScrapeToolsOptions) => createScrapeTools({
    ...options,
    runCli: async args => {
      if (args[0] !== "search") {
        return { code: 0, stderr: "", stdout: JSON.stringify(detail("freehire-low", "https://jobs.example.test/freehire-low")) };
      }
      const result = options?.source === "linkedin"
        ? { id: "1234567", title: "Backend Engineer", company: "Example", location: "Remote", url: "https://www.linkedin.com/jobs/view/backend-engineer-1234567/" }
        : activeRunId === "trajectory-a"
          ? { id: "freehire-match", title: "Backend Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/freehire-match" }
          : { id: "freehire-low", title: "PHP Developer", company: "Legacy", location: "Remote", url: "https://jobs.example.test/freehire-low" };
      return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 1 }, results: [result] }) };
    },
  });
  const execute = createAgentSearchExecutor({
    loadGuidance: async () => "bounded guidance",
    createSourceTools,
    createSession: async (_settings, tools) => {
      currentTools = tools;
      return new FakeSession();
    },
    runPi: async options => {
      await options.createSession();
      const tools = currentTools!;
      const call = async (name: string, params: Record<string, string | number>) => {
        calls.push(`${activeRunId}:${name}:${String(params.source ?? "")}:${String(params.query ?? "")}`);
        if (name === "searchJobs") return tools.searchJobs.execute(`${activeRunId}-search-${calls.length}`, params, undefined, undefined, undefined as never);
        if (name === "inspectSearchState") return tools.inspectSearchState.execute(`${activeRunId}-inspect-${calls.length}`, params, undefined, undefined, undefined as never);
        if (name === "finishSearch") return tools.finishSearch.execute(`${activeRunId}-finish`, params, undefined, undefined, undefined as never);
        throw new Error(`Unexpected tool ${name}`);
      };
      await call("searchJobs", { source: "freehire", query: "backend", location: "", limit: 1 });
      let inspected = textResult(await call("inspectSearchState", {}));
      while (!inspected.coverageSufficient || inspected.sourceCoverage.unsearched.length) {
        if (activeRunId === "trajectory-b" && inspected.sourceStats.freehire.duplicateCount > 0) assert.equal(inspected.marginalUtility.status, "low");
        const floorSearch = inspected.nextSearch?.reason === "source_floor" ? inspected.nextSearch : undefined;
        const uncoveredSource = floorSearch?.source ?? (inspected.coverageSufficient ? inspected.sourceCoverage.unsearched[0] : undefined);
        const source = uncoveredSource ?? (inspected.marginalUtility.status === "low" && inspected.sourceStats.freehire.duplicateCount > 0 ? "linkedin" : "freehire");
        const query = floorSearch?.query ?? (uncoveredSource ? "backend" : "backend alternate");
        await call("searchJobs", { source, query, location: floorSearch?.location ?? (source === "linkedin" ? "Remote" : ""), limit: floorSearch?.limit ?? 1 });
        inspected = textResult(await call("inspectSearchState", {}));
      }
      await call("finishSearch", { reason: "Coverage is sufficient.", reasonCategory: "coverage_sufficient" });
      const source = activeRunId === "trajectory-a" ? "freehire" : "linkedin";
      const sourceId = activeRunId === "trajectory-a" ? "freehire-match" : "1234567";
      const url = activeRunId === "trajectory-a" ? "https://jobs.example.test/freehire-match" : "https://www.linkedin.com/jobs/view/backend-engineer-1234567/";
      options.onAssistantText?.(JSON.stringify({ jobs: [{ sourceId, source, url, company: "", role: "Backend Engineer", location: "Remote", posting: "metadata", score: 80, reason: "fit", strengths: [], gaps: [] }] }));
    },
  });
  const context = {
    profile: "Backend engineer",
    criteria: { ...defaultCriteria, roles: ["Backend Engineer"], locations: ["Remote"], maxJobsPerRun: 1 },
    settings: { ...defaultSettings, enabledSources: ["freehire", "linkedin"] },
    searchBudget: { maxSearchCalls: 5, maxTotalResults: 5 },
    signal: new AbortController().signal,
  } satisfies ScrapeContext;

  activeRunId = "trajectory-a";
  await execute({ ...context, runId: activeRunId });
  activeRunId = "trajectory-b";
  await execute({ ...context, runId: activeRunId });

  assert.deepEqual(calls.filter(call => call.startsWith("trajectory-a:")).map(call => call.split(":").slice(1, 3)), [
    ["searchJobs", "freehire"],
    ["inspectSearchState", ""],
    ["searchJobs", "linkedin"],
    ["inspectSearchState", ""],
    ["finishSearch", ""],
  ]);
  assert.deepEqual(calls.filter(call => call.startsWith("trajectory-b:")).map(call => call.split(":").slice(1, 3)), [
    ["searchJobs", "freehire"],
    ["inspectSearchState", ""],
    ["searchJobs", "linkedin"],
    ["inspectSearchState", ""],
    ["finishSearch", ""],
  ]);
});

test("agent executor uses one Pi session and rejects a missing finishSearch", async () => {
  class FakeSession implements PiSessionLike {
    subscribe() { return () => {}; }
    async prompt() {}
    async abort() {}
    dispose() {}
  }

  let tools: AgentSearchTools | undefined;
  let sessionCount = 0;
  let prompt = "";
  const run = createAgentSearchExecutor({
    loadGuidance: async () => "bounded guidance",
    createSourceTools: sourceFactory(async (args) => args[0] === "search"
      ? { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 1 }, results: [{ id: "job-1", title: "Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/one" }] }) }
      : { code: 0, stderr: "", stdout: JSON.stringify(detail("job-1", "https://jobs.example.test/one")) }),
    createSession: async (_settings, value) => { tools = value; sessionCount += 1; return new FakeSession(); },
    runPi: async (options) => {
      prompt = options.prompt;
      await options.createSession();
      await tools!.searchJobs.execute("search", { source: "freehire", query: "engineer", location: "", limit: 1 }, undefined, undefined, undefined as never);
      await tools!.fetchJobDetails.execute("detail", { source: "freehire", resultId: "job-1" }, undefined, undefined, undefined as never);
      await tools!.finishSearch.execute("finish", { reason: "One enriched match is sufficient." }, undefined, undefined, undefined as never);
      options.onAssistantText?.(JSON.stringify({ jobs: [{ sourceId: "job-1", source: "freehire", url: "https://jobs.example.test/one", company: "Example", role: "Engineer", location: "Remote", posting: "metadata", score: 80, reason: "fit", strengths: [], gaps: [] }] }));
    },
  });
  const context = {
    profile: JSON.stringify({
      identity: { headline: "Platform Engineer", city: "Jakarta", country: "Indonesia" },
      workPreferences: { targetRoles: ["Platform Engineer"], remotePreference: "Remote", dealBreakers: [] },
      experience: [{ title: "Backend Engineer", location: "Jakarta" }],
      skills: [{ name: "TypeScript" }],
    }),
    criteria: { ...defaultCriteria, maxJobsPerRun: 1 },
    settings: { ...defaultSettings, enabledSources: ["freehire"] },
    signal: new AbortController().signal,
  } satisfies ScrapeContext;
  const output = await run(context);
  assert.equal(sessionCount, 1);
  assert.deepEqual(tools!.state.goal.criteria.locations, ["Remote"]);
  assert.doesNotMatch(prompt, /fetch every returned/i);
  assert.ok(prompt.includes(`Return only JSON matching ${JSON.stringify({ jobs: [{ sourceId: "", source: "", url: "", company: "", role: "", location: "", posting: "", score: 0, reason: "", strengths: [], gaps: [] }] })}. Maximum jobs: 1. Use only source IDs and URLs returned by the tools.`));
  assert.match(prompt, /TRUSTED PROFILE SEARCH HINTS/);
  assert.match(prompt, /Platform Engineer/);
  assert.match(prompt, /Remote/);
  assert.match(prompt, /TypeScript/);
  assert.match(prompt, /keyword coverage remains unknown until every promising candidate has detail/i);
  assert.equal((output.result as { jobs: Array<{ posting: string }> }).jobs[0]?.posting, "Full posting for the selected job.");
  const cityOnlyContext = {
    ...context,
    profile: JSON.stringify({
      identity: { headline: "Platform Engineer", city: "Jakarta", country: "Indonesia" },
      workPreferences: { targetRoles: ["Platform Engineer"], remotePreference: "", dealBreakers: [] },
      experience: [{ title: "Backend Engineer", location: "Jakarta" }],
      skills: [{ name: "TypeScript" }],
    }),
  };
  await run(cityOnlyContext);
  assert.deepEqual(tools!.state.goal.criteria.locations, ["Jakarta"]);

  const missingFinish = createAgentSearchExecutor({
    loadGuidance: async () => "bounded guidance",
    createSession: async () => new FakeSession(),
    runPi: async (options) => {
      await options.createSession();
      options.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: JSON.stringify({ jobs: [] }) } });
    },
  });
  await assert.rejects(missingFinish(context), SearchNotFinishedError);

  const unfinished = makeAgentTools(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) }));
  assert.throws(() => unfinished.state.assertFinished(), SearchNotFinishedError);
});


test("profile-led multi-source search scales coverage budget across every enabled source", async () => {
  class EmptySession implements PiSessionLike {
    subscribe() { return () => {}; }
    async prompt() {}
    async abort() {}
    dispose() {}
  }
  const enabledSources = ["freehire", "linkedin", "tokyodev", "japan-dev", "relocate-me", "ycombinator-remote", "indeed-id"] as const;
  let tools: AgentSearchTools | undefined;
  let prompt = "";
  const searched: string[] = [];
  const createSourceTools = (options: ScrapeToolsOptions) => ({
    searchJobs: { execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ meta: { count: 0 }, results: [] }) }] }) },
    fetchJobDetails: { execute: async () => { throw new Error("detail should not be called"); } },
    manifest: { label: String(options?.source) },
    warnings: [],
  } as unknown as ScrapeTools);
  const run = createAgentSearchExecutor({
    loadGuidance: async () => "bounded guidance",
    createSourceTools,
    createSession: async (_settings, value) => { tools = value; return new EmptySession(); },
    runPi: async options => {
      prompt = options.prompt;
      await options.createSession();
      for (const source of enabledSources) {
        searched.push(source);
        await tools!.searchJobs.execute(`search-${source}`, { source, query: "platform engineer", location: "Remote", limit: 1 }, undefined, undefined, undefined as never);
      }
      const inspected = textResult(await tools!.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
      assert.equal(inspected.remaining.maxSearchCalls, 13);
      assert.deepEqual(inspected.sourceCoverage.unsearched, []);
      await tools!.finishSearch.execute("finish", { reason: "Every enabled source returned no matches.", reasonCategory: "no_results" }, undefined, undefined, undefined as never);
      options.onAssistantText?.(JSON.stringify({ jobs: [] }));
    },
  });
  const context = {
    profile: JSON.stringify({
      identity: { headline: "Platform Engineer", summary: "Reliable services" },
      workPreferences: { targetRoles: [], remotePreference: "Remote preferred", dealBreakers: [] },
      skills: [{ name: "TypeScript" }],
    }),
    criteria: { ...defaultCriteria, maxJobsPerRun: enabledSources.length },
    settings: { ...defaultSettings, enabledSources: [...enabledSources] },
    searchBudget: { maxQueryVariantsPerSource: 1 },
    signal: new AbortController().signal,
  } satisfies ScrapeContext;
  const output = await run(context);
  assert.deepEqual(searched, [...enabledSources]);
  assert.deepEqual((output.result as { jobs: unknown[] }).jobs, []);
  assert.match(prompt, /saved candidate profile is the primary discovery context/i);
  assert.match(prompt, /TypeScript/);
});
test("agent executor follows a faux Pi observation loop", async () => {
  const calls: string[] = [];
  const events: Array<{ type: string; kind: string; payload?: unknown }> = [];
  let loopTools: AgentSearchTools | undefined;
  const jobOne = { id: "job-1", title: "Backend Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/backend-one" };
  const jobTwo = { id: "job-2", title: "Platform Engineer", company: "Example", location: "Remote", url: "https://jobs.example.test/platform-two" };
  const jobThree = { id: "job-3", title: "Platform Engineer", company: "Other", location: "Remote", url: "https://jobs.example.test/platform-three" };
  const sourceTools = sourceFactory(async args => args[0] === "search"
    ? args.includes("backend")
      ? { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 2 }, results: [jobOne, jobTwo] }) }
      : { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 1 }, results: [jobThree] }) }
    : { code: 0, stderr: "", stdout: JSON.stringify(detail("job-2", jobTwo.url)) });
  const faux = fauxProvider({ provider: "job-sequencer-agent-test", models: [{ id: "adaptive", reasoning: false }], tokenSize: { min: 1000, max: 1000 } });
  const runtime = await ModelRuntime.create({ authPath: join(process.cwd(), ".pi-disabled", "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: join(process.cwd(), ".pi-disabled"), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Run only the supplied bounded search tools." });
  await loader.reload();

  const nextResponse = (context: Context) => {
    const messages = context.messages.filter(message => message.role === "toolResult");
    const last = messages.at(-1);
    const lastText = last?.content.map(block => block.type === "text" ? block.text : "").join("") ?? "";
    const allText = messages.flatMap(message => message.content).map(block => block.type === "text" ? block.text : "").join("\n");
    if (!last) {
      calls.push("searchJobs:backend");
      return fauxAssistantMessage(fauxToolCall("searchJobs", { source: "freehire", query: "backend", location: "", limit: 2 }, { id: "search-backend" }), { stopReason: "toolUse" });
    }
    if (last.toolName === "searchJobs" && lastText.includes("job-2")) {
      calls.push("inspectSearchState:after-backend");
      return fauxAssistantMessage(fauxToolCall("inspectSearchState", {}, { id: "inspect-after-backend" }), { stopReason: "toolUse" });
    }
    if (last.toolName === "inspectSearchState" && lastText.includes("maxSearchCalls") && !lastText.includes('"enrichedCount":1')) {
      calls.push("searchJobs:platform");
      return fauxAssistantMessage(fauxToolCall("searchJobs", { source: "freehire", query: "platform", location: "", limit: 1 }, { id: "search-platform" }), { stopReason: "toolUse" });
    }
    if (last.toolName === "searchJobs" && lastText.includes("job-3") && allText.includes("job-2")) {
      calls.push("fetchJobDetails:job-2");
      return fauxAssistantMessage(fauxToolCall("fetchJobDetails", { source: "freehire", resultId: "job-2" }, { id: "detail-job-2" }), { stopReason: "toolUse" });
    }
    if (last.toolName === "fetchJobDetails" && lastText.includes("Full posting")) {
      calls.push("inspectSearchState:after-detail");
      return fauxAssistantMessage(fauxToolCall("inspectSearchState", {}, { id: "inspect-after-detail" }), { stopReason: "toolUse" });
    }
    if (last.toolName === "inspectSearchState" && lastText.includes('"enrichedCount":1')) {
      calls.push("finishSearch");
      return fauxAssistantMessage(fauxToolCall("finishSearch", { reason: "Selected one relevant candidate after adaptive discovery." }, { id: "finish-search" }), { stopReason: "toolUse" });
    }
    if (last.toolName === "finishSearch" && lastText.includes('"finished":true')) {
      return fauxAssistantMessage(JSON.stringify({ jobs: [{ sourceId: "job-2", source: "freehire", url: jobTwo.url, company: jobTwo.company, role: jobTwo.title, location: jobTwo.location, posting: "metadata", score: 84, reason: "Platform fit", strengths: ["Platform"], gaps: [] }] }));
    }
    throw new Error("Unexpected faux Pi observation after " + last.toolName + ": " + lastText);
  };
  faux.setResponses(Array.from({ length: 7 }, () => nextResponse));

  const run = createAgentSearchExecutor({
    loadGuidance: async () => "bounded guidance",
    createSourceTools: sourceTools,
    createSession: async (_settings, tools) => {
      loopTools = tools;
      const { session } = await createAgentSession({
        cwd: process.cwd(),
        model: faux.getModel(),
        modelRuntime: runtime,
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(process.cwd()),
        noTools: "builtin",
        tools: tools.allTools.map(tool => tool.name),
        customTools: tools.allTools,
        thinkingLevel: "off",
      });
      return session;
    },
  });
  const context = {
    profile: "Backend and platform engineer",
    criteria: { ...defaultCriteria, maxJobsPerRun: 2 },
    settings: { ...defaultSettings, enabledSources: ["freehire"] },
    searchBudget: { maxSearchCalls: 3, maxDetailCalls: 2, maxTotalResults: 5 },
    runId: "faux-agent-loop",
    trajectory: (_runId: string, event: { type: string; kind: string; payload?: unknown }) => events.push(event),
    signal: new AbortController().signal,
  } satisfies ScrapeContext;

  const output = await run(context);
  assert.deepEqual(calls, ["searchJobs:backend", "inspectSearchState:after-backend", "searchJobs:platform", "fetchJobDetails:job-2", "inspectSearchState:after-detail", "finishSearch"]);
  assert.equal((output.result as { jobs: Array<{ sourceId: string; posting: string }> }).jobs[0]?.sourceId, "job-2");
  assert.equal((output.result as { jobs: Array<{ posting: string }> }).jobs[0]?.posting, "Full posting for the selected job.");
  const toolCalls = events.filter(event => event.kind === "tool_call").map(event => {
    const payload = event.payload as { toolName?: string };
    return payload.toolName;
  });
  assert.deepEqual(toolCalls, ["searchJobs", "inspectSearchState", "searchJobs", "fetchJobDetails", "inspectSearchState", "finishSearch"]);
  const remaining = loopTools?.state.snapshot().remaining;
  assert.equal(remaining?.maxSearchCalls, 1);
  assert.equal(remaining?.maxDetailCalls, 1);
  assert.equal(remaining?.maxTotalResults, 2);
  assert.ok((remaining?.maxRunDurationMs ?? 0) > 0);
});

test("agent executor treats a clean zero-match finish as success", async () => {
  class EmptySession implements PiSessionLike {
    subscribe() { return () => {}; }
    async prompt() {}
    async abort() {}
    dispose() {}
  }
  let tools: AgentSearchTools | undefined;
  const run = createAgentSearchExecutor({
    loadGuidance: async () => "bounded guidance",
    createSourceTools: sourceFactory(async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) })),
    createSession: async (_settings, value) => { tools = value; return new EmptySession(); },
    runPi: async options => {
      await options.createSession();
      await tools!.searchJobs.execute("empty-search", { source: "freehire", query: "backend", location: "", limit: 1 }, undefined, undefined, undefined as never);
      await tools!.finishSearch.execute("empty-finish", { reason: "No relevant jobs found." }, undefined, undefined, undefined as never);
      options.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: JSON.stringify({ jobs: [] }) } });
    },
  });
  const context = {
    profile: "Backend engineer",
    criteria: { ...defaultCriteria, maxJobsPerRun: 1 },
    settings: { ...defaultSettings, enabledSources: ["freehire"] },
    signal: new AbortController().signal,
  } satisfies ScrapeContext;
  const output = await run(context);
  assert.deepEqual((output.result as { jobs: unknown[] }).jobs, []);
  assert.equal(tools?.state.snapshot().attempts[0]?.status, "completed");
});

test("agent executor still rejects an empty finish when every search action fails", async () => {
  class EmptySession implements PiSessionLike {
    subscribe() { return () => {}; }
    async prompt() {}
    async abort() {}
    dispose() {}
  }
  let tools: AgentSearchTools | undefined;
  let funnelPayload: unknown;
  const run = createAgentSearchExecutor({
    loadGuidance: async () => "bounded guidance",
    createSourceTools: sourceFactory(async () => ({ code: 1, stderr: "fixture source unavailable", stdout: "" })),
    createSession: async (_settings, value) => { tools = value; return new EmptySession(); },
    runPi: async options => {
      await options.createSession();
      await assert.rejects(tools!.searchJobs.execute("failed-search", { source: "freehire", query: "backend", location: "", limit: 1 }, undefined, undefined, undefined as never));
      await tools!.finishSearch.execute("failed-finish", { reason: "No source returned usable data." }, undefined, undefined, undefined as never);
      options.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: JSON.stringify({ jobs: [] }) } });
    },
  });
  const context = {
    profile: "Backend engineer",
    criteria: { ...defaultCriteria, maxJobsPerRun: 1 },
    settings: { ...defaultSettings, enabledSources: ["freehire"] },
    runId: "all-source-failure",
    trajectory: (_runId, event) => { if (event.type === "search_funnel") funnelPayload = event.payload; },
    signal: new AbortController().signal,
  } satisfies ScrapeContext;
  let failure: unknown;
  try { await run(context); } catch (error) { failure = error; }
  assert.ok(failure instanceof AllSourcesFailedError);
  assert.deepEqual(failure.funnel?.sourceCoverage, {
    required: ["freehire"],
    searched: ["freehire"],
    unavailable: ["freehire"],
    unsearched: [],
  });
  assert.equal(failure.funnel?.duplicatesRemoved, 0);
  assert.deepEqual(funnelPayload, failure.funnel);
});

test("resolved search budget exposes bounded exploratory defaults", () => {
  const budget = resolveSearchBudget({}, 50, 3);
  assert.deepEqual({
    targetUniqueJobs: budget.targetUniqueJobs,
    maxSearchCalls: budget.maxSearchCalls,
    maxDetailCalls: budget.maxDetailCalls,
    maxTotalResults: budget.maxTotalResults,
    minSearchesPerSource: budget.minSearchesPerSource,
    maxSearchesPerSource: budget.maxSearchesPerSource,
    maxPagesPerQuery: budget.maxPagesPerQuery,
    maxQueryVariantsPerSource: budget.maxQueryVariantsPerSource,
  }, {
    targetUniqueJobs: 50,
    maxSearchCalls: 20,
    maxDetailCalls: 30,
    maxTotalResults: 100,
    minSearchesPerSource: 1,
    maxSearchesPerSource: 12,
    maxPagesPerQuery: 3,
    maxQueryVariantsPerSource: 6,
  });
});

test("adaptive recommendations cover sources and continue productive pagination", async () => {
  const calls: Array<{ source: string; args: string[] }> = [];
  const job = (source: string, id: string) => ({
    id,
    title: "Backend Engineer",
    company: "Example",
    location: "Remote",
    url: source === "linkedin" ? `https://www.linkedin.com/jobs/view/${id}` : `https://jobs.example.test/${id}`,
  });
  const createSourceTools = (options: ScrapeToolsOptions) => createScrapeTools({
    ...options,
    runCli: async args => {
      calls.push({ source: options.source ?? "", args });
      if (args[0] !== "search") return { code: 0, stderr: "", stdout: JSON.stringify(detail("fh-1", "https://jobs.example.test/fh-1")) };
      const pageIndex = args.indexOf("--page");
      const page = pageIndex >= 0 ? Number(args[pageIndex + 1]) : 1;
      const source = options.source ?? "";
      const results = source === "freehire"
        ? page === 2 ? [job(source, "fh-3"), job(source, "fh-4")] : [job(source, "fh-1"), job(source, "fh-2")]
        : [job(source, "li-1")];
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify(source === "freehire"
          ? { meta: { count: results.length, page, total: 26 }, results }
          : { meta: { count: results.length }, results }),
      };
    },
  });
  const tools = createAgentSearchTools({
    sources: [
      { key: "freehire", querySeeds: ["backend engineer"] },
      { key: "linkedin", querySeeds: ["backend engineer"] },
    ],
    goal: { criteria: { ...defaultCriteria, roles: ["Backend Engineer"], locations: ["Remote"], maxJobsPerRun: 3 }, enabledSources: ["freehire", "linkedin"] },
    budget: { targetUniqueJobs: 5, maxSearchCalls: 4, maxTotalResults: 20 },
    createSourceTools,
  });
  const inspect = async () => textResult(await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
  let state = await inspect();
  assert.deepEqual({ source: state.nextSearch.source, query: state.nextSearch.query, reason: state.nextSearch.reason }, { source: "freehire", query: "backend engineer", reason: "source_floor" });
  await tools.searchJobs.execute("freehire-page-1", { source: "freehire", query: "backend engineer", location: "Remote", limit: 25 }, undefined, undefined, undefined as never);
  state = await inspect();
  assert.equal(state.nextSearch.source, "linkedin");
  assert.equal(state.nextSearch.reason, "source_floor");
  await tools.searchJobs.execute("linkedin-page-1", { source: "linkedin", query: "backend engineer", location: "Remote", limit: 25 }, undefined, undefined, undefined as never);
  state = await inspect();
  assert.deepEqual({ source: state.nextSearch.source, page: state.nextSearch.page, reason: state.nextSearch.reason }, { source: "freehire", page: 2, reason: "paginate" });
  await assert.rejects(
    tools.finishSearch.execute("premature-finish", { reason: "Promising candidates found.", reasonCategory: "candidates_sufficient" }, undefined, undefined, undefined as never),
    /adaptive search still has viable work/i,
  );
  await tools.searchJobs.execute("freehire-page-2", { source: "freehire", query: "backend engineer", location: "Remote", limit: 25, page: 2 }, undefined, undefined, undefined as never);
  state = await inspect();
  assert.equal(state.plannerStop, "target_reached");
  assert.equal(state.uniqueCount, 5);
  const finished = textResult(await tools.finishSearch.execute("finish", { reason: "Target unique jobs reached.", reasonCategory: "candidates_sufficient" }, undefined, undefined, undefined as never));
  assert.equal(finished.finished, true);
  const paginationCall = calls.find(call => call.source === "freehire" && call.args.includes("--page"));
  assert.equal(paginationCall?.args[paginationCall.args.indexOf("--page") + 1], "2");
});
test("adaptive planner keeps source fallbacks as planner seeds", () => {
  let sourceOptions: ScrapeToolsOptions | undefined;
  const tools = createAgentSearchTools({
    sources: [{ key: "japan-dev", fallbackQueries: ["backend", "platform"] }],
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["japan-dev"] },
    budget: { targetUniqueJobs: 5, maxSearchCalls: 2, maxDetailCalls: 1, maxTotalResults: 5, maxQueryVariantsPerSource: 2 },
    createSourceTools: options => {
      sourceOptions = options;
      return createScrapeTools({ ...options, runCli: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) }) });
    },
  });
  assert.equal(sourceOptions?.fallbackQueries, undefined);
  assert.equal(tools.state.snapshot().nextSearch?.query, "backend");
});

test("adaptive finish requires planner exhaustion after candidate enrichment", () => {
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria, roles: ["Backend Engineer"], maxJobsPerRun: 1 }, enabledSources: ["freehire"] },
    budget: { targetUniqueJobs: 10, maxSearchCalls: 3, maxDetailCalls: 1, maxTotalResults: 10, maxQueryVariantsPerSource: 2 },
    adaptive: true,
    querySeeds: new Map([["freehire", ["backend", "platform"]]]),
  });
  const search = state.reserveSearch({ source: "freehire", query: "backend", location: "", limit: 1 });
  state.completeSearch(search, [{ source: "freehire", sourceId: "job-1", title: "Backend Engineer", url: "https://jobs.example.test/job-1" }]);
  const detailReservation = state.reserveDetail({ source: "freehire", resultId: "job-1" });
  state.completeDetail(detailReservation, "Backend Engineer platform APIs.");
  assert.equal(state.snapshot().nextSearch?.query, "platform");
  assert.throws(() => state.finish("One enriched candidate is sufficient.", [], "candidates_sufficient"), /adaptive search still has viable work/i);
  const next = state.reserveSearch({ source: "freehire", query: "platform", location: "", limit: 1 });
  state.completeSearch(next, []);
  assert.equal(state.snapshot().plannerStop, "paths_exhausted");
  assert.equal(state.finish("All useful query paths are exhausted.", [], "candidates_sufficient")?.reasonCategory, "candidates_sufficient");
});

test("adaptive search stops after repeated low-yield source exploration saturates", () => {
  const sources = jobSourceKeys.slice(0, 4);
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: sources },
    budget: { targetUniqueJobs: 50, maxSearchCalls: 8, maxDetailCalls: 1, maxTotalResults: 20, minSearchesPerSource: 1, maxSearchesPerSource: 1, maxQueryVariantsPerSource: 1 },
    adaptive: true,
    querySeeds: Object.fromEntries(sources.map(source => [source, ["backend engineer"]])),
  });
  for (const source of sources) {
    const nextSearch = state.snapshot().nextSearch;
    assert.ok(nextSearch);
    assert.deepEqual({ source: nextSearch.source, reason: nextSearch.reason }, { source, reason: "source_floor" });
    state.completeSearch(state.reserveSearch({ source, query: nextSearch.query, location: nextSearch.location, limit: 1 }), []);
  }
  const inspected = state.snapshot();
  assert.deepEqual(inspected.sourceCoverage, { required: sources, searched: sources, unavailable: [], unsearched: [] });
  assert.equal(inspected.nextSearch, null);
  assert.equal(inspected.plannerStop, "marginal_yield_saturated");
  assert.equal(inspected.marginalUtility.recentUniqueJobs, 0);
  assert.equal(state.finish("Recent searches produced negligible unique yield.", [], "no_results")?.reasonCategory, "no_results");
});


test("adaptive recommendations mutate low-yield queries without equivalent repeats", async () => {
  const queries: string[] = [];
  const tools = createAgentSearchTools({
    sources: [{ key: "freehire", querySeeds: ["backend engineer", "backend", "engineer"] }],
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] },
    budget: { targetUniqueJobs: 10, maxSearchCalls: 4, maxTotalResults: 10 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        if (args[0] === "search") queries.push(args[args.indexOf("--query") + 1] ?? "");
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) };
      },
    }),
  });
  const inspect = async () => textResult(await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
  for (let index = 0; index < 3; index += 1) {
    const state = await inspect();
    assert.ok(state.nextSearch);
    await tools.searchJobs.execute(`search-${index}`, {
      source: state.nextSearch.source,
      query: state.nextSearch.query,
      location: state.nextSearch.location,
      limit: state.nextSearch.limit,
      ...(state.nextSearch.page ? { page: state.nextSearch.page } : {}),
    }, undefined, undefined, undefined as never);
  }
  const exhausted = await inspect();
  assert.equal(exhausted.nextSearch, null);
  assert.equal(exhausted.plannerStop, "paths_exhausted");
  assert.deepEqual(queries, ["backend engineer", "backend", "engineer"]);
  await tools.finishSearch.execute("finish", { reason: "All deterministic query variants returned no jobs.", reasonCategory: "no_results" }, undefined, undefined, undefined as never);
});
test("adaptive planner derives deterministic query variants from a short seed", () => {
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] },
    budget: { targetUniqueJobs: 10, maxSearchCalls: 3, maxTotalResults: 10, maxQueryVariantsPerSource: 3 },
    adaptive: true,
    querySeeds: { freehire: ["backend engineer"] },
    sourceCapabilities: { freehire: false },
  });
  const first = state.reserveSearch({ source: "freehire", query: "backend engineer", location: "", limit: 25 });
  state.completeSearch(first, []);
  assert.equal(state.snapshot().nextSearch?.query, "backend");
  const second = state.reserveSearch({ source: "freehire", query: "backend", location: "", limit: 25 });
  state.completeSearch(second, []);
  assert.equal(state.snapshot().nextSearch?.query, "engineer");
});

test("adaptive planner allocates productive sources before weaker variants", () => {
  const hit = (source: string, id: string) => ({
    source,
    sourceId: id,
    title: "Engineer",
    company: "Example",
    location: "Remote",
    url: `https://jobs.example.test/${source}/${id}`,
  });
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire", "linkedin", "tokyodev"] },
    budget: { targetUniqueJobs: 50, maxSearchCalls: 8, maxTotalResults: 30, maxSearchesPerSource: 4, maxQueryVariantsPerSource: 3 },
    adaptive: true,
    querySeeds: {
      freehire: ["backend"],
      linkedin: ["backend"],
      tokyodev: ["backend", "backend platform"],
    },
    sourceCapabilities: { freehire: false, linkedin: false, tokyodev: false },
  });
  const search = (source: string, query: string, hits: ReturnType<typeof hit>[]) => {
    const reservation = state.reserveSearch({ source, query, location: "", limit: 25 });
    state.completeSearch(reservation, hits);
  };
  assert.deepEqual(state.snapshot().nextSearch, {
    source: "freehire",
    query: "backend",
    location: "",
    limit: 25,
    reason: "source_floor",
  });
  search("freehire", "backend", [hit("freehire", "fh-1")]);
  assert.equal(state.snapshot().nextSearch?.source, "linkedin");
  search("linkedin", "backend", []);
  assert.equal(state.snapshot().nextSearch?.source, "tokyodev");
  search("tokyodev", "backend", ["td-1", "td-2", "td-3", "td-4"].map(id => hit("tokyodev", id)));
  assert.deepEqual({
    source: state.snapshot().nextSearch?.source,
    query: state.snapshot().nextSearch?.query,
    reason: state.snapshot().nextSearch?.reason,
  }, { source: "tokyodev", query: "backend platform", reason: "exploit_source" });
  search("tokyodev", "backend platform", []);
  assert.throws(
    () => state.reserveSearch({ source: "tokyodev", query: "platform backend", location: "", limit: 1 }),
    /equivalent source\/query\/location\/page path/i,
  );
});

test("adaptive low-yield variants keep explicit seed order and canonical novelty", async () => {
  const queries: string[] = [];
  const tools = createAgentSearchTools({
    sources: [{ key: "freehire", querySeeds: ["backend engineer", "engineer backend", "backend"] }],
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 4, maxTotalResults: 10, maxQueryVariantsPerSource: 4 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        if (args[0] !== "search") return { code: 0, stderr: "", stdout: "{}" };
        const query = args[args.indexOf("--query") + 1] ?? "";
        queries.push(query);
        const results = query === "backend engineer" ? ["one", "two"].map(id => ({
          id,
          title: "Engineer",
          company: null,
          location: null,
          url: `https://jobs.example.test/${id}`,
        })) : [];
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: results.length }, results }) };
      },
    }),
  });
  const inspect = async () => textResult(await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
  for (const query of ["backend engineer", "backend", "engineer"]) {
    const state = await inspect();
    assert.equal(state.nextSearch?.query, query);
    await tools.searchJobs.execute(`search-${query}`, {
      source: state.nextSearch.source,
      query: state.nextSearch.query,
      location: state.nextSearch.location,
      limit: state.nextSearch.limit,
    }, undefined, undefined, undefined as never);
  }
  assert.deepEqual(queries, ["backend engineer", "backend", "engineer"]);
  assert.equal(new Set(queries.map(query => query.toLowerCase().split(/\s+/).sort().join(" "))).size, queries.length);
  assert.equal((await inspect()).nextSearch, null);
});

test("adaptive high-yield low-coverage attempts append positive criteria only", async () => {
  const criteria = { ...defaultCriteria, roles: ["Backend Engineer"], locations: ["Remote"], excludeKeywords: ["PHP"] };
  const queries: string[] = [];
  const tools = createAgentSearchTools({
    sources: [{ key: "freehire", querySeeds: ["lead"] }],
    goal: { criteria, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 5, maxTotalResults: 20, maxQueryVariantsPerSource: 4 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        if (args[0] !== "search") return { code: 0, stderr: "", stdout: "{}" };
        const query = args[args.indexOf("--query") + 1] ?? "";
        queries.push(query);
        const results = Array.from({ length: 3 }, (_, index) => ({
          id: `result-${queries.length}-${index}`,
          title: "Product Manager",
          company: "Example",
          location: "Remote",
          url: `https://jobs.example.test/result-${queries.length}-${index}`,
        }));
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: results.length }, results }) };
      },
    }),
  });
  const inspect = async () => textResult(await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
  for (const query of ["lead", "Backend Engineer"]) {
    const state = await inspect();
    assert.equal(state.nextSearch?.query, query);
    await tools.searchJobs.execute(`search-${query}`, {
      source: state.nextSearch.source,
      query: state.nextSearch.query,
      location: state.nextSearch.location,
      limit: state.nextSearch.limit,
    }, undefined, undefined, undefined as never);
  }
  const narrowed = await inspect();
  assert.equal(narrowed.nextSearch.query, "lead Backend Engineer");
  assert.doesNotMatch(narrowed.nextSearch.query, /PHP/i);
  assert.deepEqual(tools.state.goal.criteria.excludeKeywords, ["PHP"]);
  assert.equal(tools.state.goal.criteria.remoteOnly, false);
  assert.equal(passesHardSearchConstraints(
    { title: "Backend Engineer", company: "Example", location: "Remote" },
    criteria,
    "PHP Developer role",
  ), false);
});

test("adaptive high-yield location gaps schedule another configured location", async () => {
  const searches: Array<{ query: string; location: string }> = [];
  const tools = createAgentSearchTools({
    sources: [{ key: "freehire", querySeeds: ["backend"] }],
    goal: { criteria: { ...defaultCriteria, locations: ["Remote", "Singapore", "Osaka"] }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 3, maxTotalResults: 10, maxQueryVariantsPerSource: 1 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        if (args[0] !== "search") return { code: 0, stderr: "", stdout: "{}" };
        searches.push({
          query: args[args.indexOf("--query") + 1] ?? "",
          location: args[args.indexOf("--city") + 1] ?? "",
        });
        const results = Array.from({ length: 3 }, (_, index) => ({
          id: `remote-${index}`,
          title: "Backend Engineer",
          company: "Example",
          location: index === 0 ? "Remote" : "Singapore",
          url: `https://jobs.example.test/remote-${index}`,
        }));
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: results.length }, results }) };
      },
    }),
  });
  const first = tools.state.snapshot().nextSearch!;
  assert.deepEqual({ query: first.query, location: first.location }, { query: "backend", location: "Remote" });
  await tools.searchJobs.execute("remote-search", {
    source: first.source,
    query: first.query,
    location: first.location,
    limit: first.limit,
  }, undefined, undefined, undefined as never);
  const next = tools.state.snapshot().nextSearch;
  assert.deepEqual(next && { query: next.query, location: next.location }, { query: "backend", location: "Osaka" });
  assert.deepEqual(searches, [{ query: "backend", location: "Remote" }]);
});

test("location-unsupported Japan boards do not schedule location-only searches", async () => {
  for (const [source, withHits] of [["tokyodev", true], ["tokyodev", false], ["japan-dev", true], ["japan-dev", false]] as const) {
    const searches: string[][] = [];
    const tools = createAgentSearchTools({
      sources: [{ key: source, querySeeds: ["backend"] }],
      goal: { criteria: { ...defaultCriteria, locations: ["Tokyo", "Osaka"] }, enabledSources: [source] },
      budget: { maxSearchCalls: 3, maxTotalResults: 10, maxQueryVariantsPerSource: 1 },
      createSourceTools: options => createScrapeTools({
        ...options,
        runCli: async args => {
          if (args[0] !== "search") return { code: 0, stderr: "", stdout: "{}" };
          searches.push(args);
          const results = withHits ? Array.from({ length: 3 }, (_, index) => ({
            id: `${source}-${index}`,
            title: "Backend Engineer",
            company: "Example",
            location: "Remote",
            url: `https://jobs.example.test/${source}-${index}`,
          })) : [];
          return { code: 0, stderr: "", stdout: JSON.stringify({ count: results.length, results }) };
        },
      }),
    });
    const first = tools.state.snapshot().nextSearch!;
    assert.equal(first.source, source);
    await tools.searchJobs.execute(`${source}-search-${withHits}`, {
      source: first.source,
      query: first.query,
      location: first.location,
      limit: first.limit,
    }, undefined, undefined, undefined as never);
    assert.equal(searches.length, 1);
    assert.equal(tools.state.snapshot().nextSearch, null);
  }
});
test("location-insensitive built-in sources do not schedule location variants", async () => {
  for (const source of ["relocate-me", "ycombinator-remote"] as const) {
    let searchCalls = 0;
    const tools = createAgentSearchTools({
      sources: [{ key: source, querySeeds: ["backend"] }],
      goal: {
        criteria: { ...defaultCriteria, locations: ["Tokyo", "Osaka"] },
        enabledSources: [source],
      },
      budget: { maxSearchCalls: 3, maxTotalResults: 10, maxQueryVariantsPerSource: 1 },
      createSourceTools: options => source === "relocate-me"
        ? createScrapeTools({
          ...options,
          runCli: async () => {
            searchCalls += 1;
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                count: 1,
                results: [{
                  id: "relocate-fixture",
                  title: "Backend Engineer",
                  company: "Example",
                  location: "Remote",
                  url: "https://relocate.me/spain/example/backend-engineer",
                  postedDate: null,
                }],
              }),
            };
          },
        })
        : createScrapeTools({
          ...options,
          fetcher: async () => {
            searchCalls += 1;
            return new Response(
              `<ul><li class="job-card"><a href="/companies/example/jobs/yc-123-backend-engineer">Backend Engineer</a><span class="block font-bold md:inline">Example Co<!-- --> (S24)</span><div class="break-all md:break-normal">US / Remote</div></li></ul>`,
              { headers: { "content-type": "text/html" } },
            );
          },
        }),
    });
    const first = tools.state.snapshot().nextSearch!;
    assert.equal(first.location, "Tokyo");
    await tools.searchJobs.execute("first", {
      source: first.source,
      query: first.query,
      location: first.location,
      limit: first.limit,
    }, undefined, undefined, undefined as never);
    assert.equal(searchCalls, 1);
    assert.equal(tools.state.snapshot().nextSearch, null);
  }
});
test("direct-state search tools fail closed on missing location capability", async () => {
  const source: JobSource = "japan-dev";
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria, locations: ["Tokyo", "Osaka"] }, enabledSources: [source] },
    budget: { maxSearchCalls: 3, maxTotalResults: 10, maxQueryVariantsPerSource: 1 },
    adaptive: true,
    querySeeds: { [source]: ["backend"] },
  });
  const sourceTools = new Map<JobSource, ScrapeTools>([
    [source, createScrapeTools({
      source,
      runCli: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ count: 0, results: [] }) }),
    })],
  ]);
  const tools = createAgentSearchTools(state, sourceTools);
  const first = state.snapshot().nextSearch!;
  assert.equal(first.source, source);
  await tools.searchJobs.execute("search", {
    source,
    query: first.query,
    location: first.location,
    limit: first.limit,
  }, undefined, undefined, undefined as never);
  assert.equal(state.snapshot().nextSearch, null);
});


test("selective detail leaves query-local keyword coverage unknown", () => {
  const state = new AgentSearchState({
    goal: {
      criteria: { ...defaultCriteria, roles: ["Backend Engineer"], keywords: ["TypeScript"] },
      enabledSources: ["freehire"],
    },
    budget: { maxSearchCalls: 5, maxTotalResults: 20, maxQueryVariantsPerSource: 3 },
    adaptive: true,
    querySeeds: { freehire: ["platform"] },
    sourceCapabilities: { freehire: false },
  });
  const search = (query: string, prefix: string) => {
    const reservation = state.reserveSearch({ source: "freehire", query, location: "", limit: 25 });
    state.completeSearch(reservation, Array.from({ length: 3 }, (_, index) => ({
      source: "freehire",
      sourceId: `${prefix}-${index}`,
      title: "Backend Engineer",
      location: "Remote",
      url: `https://jobs.example.test/${prefix}-${index}`,
    })));
  };
  const first = state.snapshot().nextSearch!;
  assert.equal(first.query, "platform");
  search(first.query, "platform");
  const detail = state.reserveDetail({ source: "freehire", resultId: "platform-0" });
  state.completeDetail(detail, "General software development.");
  const roleSeed = state.snapshot().nextSearch!;
  assert.equal(roleSeed.query, "Backend Engineer");
  search(roleSeed.query, "role");
  const keywordSeed = state.snapshot().nextSearch!;
  assert.equal(keywordSeed.query, "TypeScript");
  search(keywordSeed.query, "keyword");
  assert.equal(state.snapshot().nextSearch, null);
  assert.deepEqual(state.attempts.filter(attempt => attempt.operation === "search").map(attempt => attempt.query), ["platform", "Backend Engineer", "TypeScript"]);
});

test("duplicate-dominated pagination yields to a higher-yield source query", async () => {
  const calls: Array<{ source: string; args: string[] }> = [];
  const tools = createAgentSearchTools({
    sources: [
      { key: "freehire", querySeeds: ["backend", "platform"] },
      { key: "linkedin", querySeeds: ["backend", "cloud"] },
    ],
    goal: { criteria: { ...defaultCriteria, locations: ["Remote"] }, enabledSources: ["freehire", "linkedin"] },
    budget: { maxSearchCalls: 5, maxTotalResults: 20, maxQueryVariantsPerSource: 2, maxPagesPerQuery: 3 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        const source = options.source ?? "";
        calls.push({ source, args });
        if (args[0] !== "search") return { code: 0, stderr: "", stdout: "{}" };
        const page = args.includes("--page") ? Number(args[args.indexOf("--page") + 1]) : 1;
        const results = source === "freehire"
          ? page === 1
            ? [{ id: "freehire-one", title: "Engineer", company: null, location: "Remote", url: "https://jobs.example.test/freehire-one" }]
            : [
              { id: "cross-source-duplicate", title: "Engineer", company: null, location: "Remote", url: "https://jobs.example.test/linkedin-one" },
              { id: "freehire-two", title: "Engineer", company: null, location: "Remote", url: "https://jobs.example.test/freehire-two" },
            ]
          : [{ id: "linkedin-one", title: "Engineer", company: null, location: "Remote", url: "https://jobs.example.test/linkedin-one" }];
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            meta: source === "freehire" ? { count: results.length, page, total: 100 } : { count: results.length },
            results,
          }),
        };
      },
    }),
  });
  const inspect = async () => textResult(await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
  const runNext = async (id: string) => {
    const state = await inspect();
    assert.ok(state.nextSearch);
    await tools.searchJobs.execute(id, {
      source: state.nextSearch.source,
      query: state.nextSearch.query,
      location: state.nextSearch.location,
      limit: state.nextSearch.limit,
      ...(state.nextSearch.page === undefined ? {} : { page: state.nextSearch.page }),
    }, undefined, undefined, undefined as never);
    return state.nextSearch;
  };
  assert.deepEqual({ source: (await inspect()).nextSearch.source, query: (await inspect()).nextSearch.query }, { source: "freehire", query: "backend" });
  await runNext("freehire-first");
  await runNext("linkedin-floor");
  const page = await inspect();
  assert.deepEqual({ source: page.nextSearch.source, page: page.nextSearch.page, reason: page.nextSearch.reason }, { source: "freehire", page: 2, reason: "paginate" });
  await runNext("freehire-page-2");
  const next = await inspect();
  assert.deepEqual({ source: next.nextSearch.source, query: next.nextSearch.query, page: next.nextSearch.page }, { source: "linkedin", query: "cloud", page: undefined });
  assert.equal(calls.filter(call => call.source === "freehire" && call.args.includes("--page")).length, 1);
  assert.equal(tools.state.attempts.find(attempt => attempt.source === "freehire" && attempt.page === 2)?.duplicateCount, 1);
});

test("optional location fallback tries explicit locations then empty once", async () => {
  const locations: string[] = [];
  const tools = createAgentSearchTools({
    sources: [{ key: "freehire", querySeeds: ["backend"] }],
    goal: { criteria: { ...defaultCriteria, locations: ["Remote", "Singapore"] }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 4, maxTotalResults: 10, maxQueryVariantsPerSource: 1 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        if (args[0] === "search") {
          const index = args.indexOf("--city");
          locations.push(index < 0 ? "" : args[index + 1] ?? "");
        }
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) };
      },
    }),
  });
  for (const location of ["Remote", "Singapore", ""]) {
    const state = textResult(await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
    assert.equal(state.nextSearch?.location, location);
    await tools.searchJobs.execute(`search-${location || "empty"}`, {
      source: state.nextSearch.source,
      query: state.nextSearch.query,
      location: state.nextSearch.location,
      limit: state.nextSearch.limit,
    }, undefined, undefined, undefined as never);
  }
  assert.deepEqual(locations, ["Remote", "Singapore", ""]);
  assert.equal(textResult(await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never)).nextSearch, null);

  const locationCapabilities: Array<ReadonlyMap<JobSource, boolean> | Readonly<Record<string, boolean>>> = [
    { freehire: true },
    new Map<JobSource, boolean>([["freehire", true]]),
  ];
  for (const locationOptionalSources of locationCapabilities) {
    const state = new AgentSearchState({
      goal: { criteria: { ...defaultCriteria, locations: ["Remote"] }, enabledSources: ["freehire"] },
      budget: { maxQueryVariantsPerSource: 1 },
      adaptive: true,
      querySeeds: { freehire: ["backend"] },
      locationOptionalSources,
      sourceLocationFiltering: { freehire: true },
    });
    const first = state.snapshot().nextSearch!;
    state.completeSearch(state.reserveSearch({ source: first.source, query: first.query, location: first.location, limit: first.limit }), []);
    assert.equal(state.snapshot().nextSearch?.location, "");
  }
});

test("LinkedIn and remote-only searches never fall back to empty or other locations", async () => {
  const linkedinLocations: string[] = [];
  const linkedin = createAgentSearchTools({
    sources: [{ key: "linkedin", querySeeds: ["backend"] }],
    goal: { criteria: { ...defaultCriteria, locations: ["Remote", "Jakarta"] }, enabledSources: ["linkedin"] },
    budget: { maxSearchCalls: 3, maxTotalResults: 10, maxQueryVariantsPerSource: 1 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        if (args[0] === "search") linkedinLocations.push(args[args.indexOf("--location") + 1] ?? "");
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) };
      },
    }),
  });
  for (const location of ["Remote", "Jakarta"]) {
    const state = textResult(await linkedin.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
    assert.equal(state.nextSearch?.location, location);
    await linkedin.searchJobs.execute(`linkedin-${location}`, {
      source: state.nextSearch.source,
      query: state.nextSearch.query,
      location: state.nextSearch.location,
      limit: state.nextSearch.limit,
    }, undefined, undefined, undefined as never);
  }
  assert.deepEqual(linkedinLocations, ["Remote", "Jakarta"]);
  assert.equal(textResult(await linkedin.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never)).nextSearch, null);

  const remoteLocations: string[] = [];
  const remoteOnly = createAgentSearchTools({
    sources: [{ key: "freehire", querySeeds: ["backend"] }],
    goal: { criteria: { ...defaultCriteria, locations: ["Remote", "Jakarta"], remoteOnly: true }, enabledSources: ["freehire"] },
    budget: { maxSearchCalls: 3, maxTotalResults: 10, maxQueryVariantsPerSource: 1 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        if (args[0] === "search") {
          const index = args.indexOf("--city");
          remoteLocations.push(index < 0 ? "" : args[index + 1] ?? "");
        }
        return { code: 0, stderr: "", stdout: JSON.stringify({ meta: { count: 0 }, results: [] }) };
      },
    }),
  });
  const first = textResult(await remoteOnly.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
  await remoteOnly.searchJobs.execute("remote-only", {
    source: first.nextSearch.source,
    query: first.nextSearch.query,
    location: first.nextSearch.location,
    limit: first.nextSearch.limit,
  }, undefined, undefined, undefined as never);
  assert.deepEqual(remoteLocations, ["Remote"]);
  assert.equal(textResult(await remoteOnly.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never)).nextSearch, null);
  assert.equal(remoteOnly.state.goal.criteria.remoteOnly, true);
});

test("Japan board query variants never fabricate a location token", async () => {
  const queries: string[] = [];
  const tools = createAgentSearchTools({
    sources: [{ key: "japan-dev", querySeeds: ["backend engineer"] }],
    goal: {
      criteria: { ...defaultCriteria, roles: ["Backend Engineer"], locations: ["Tokyo"], keywords: ["TypeScript"] },
      enabledSources: ["japan-dev"],
    },
    budget: { maxSearchCalls: 4, maxTotalResults: 10, maxQueryVariantsPerSource: 3 },
    createSourceTools: options => createScrapeTools({
      ...options,
      runCli: async args => {
        if (args[0] === "search") queries.push(args[args.indexOf("--query") + 1] ?? "");
        return { code: 0, stderr: "", stdout: JSON.stringify({ count: 0, results: [] }) };
      },
    }),
  });
  while (true) {
    const state = textResult(await tools.inspectSearchState.execute("inspect", {}, undefined, undefined, undefined as never));
    if (!state.nextSearch) break;
    assert.doesNotMatch(state.nextSearch.query, /Tokyo|Japan/i);
    await tools.searchJobs.execute(`japan-${queries.length}`, {
      source: state.nextSearch.source,
      query: state.nextSearch.query,
      location: state.nextSearch.location,
      limit: state.nextSearch.limit,
    }, undefined, undefined, undefined as never);
  }
  assert.deepEqual(queries, ["backend engineer", "TypeScript", "Backend Engineer TypeScript"]);
  assert.deepEqual(tools.state.goal.criteria.locations, ["Tokyo"]);
});


test("adaptive source floors preserve one result slot per remaining source", async () => {
  const sources = [...jobSourceKeys];
  const adapterCalls: string[] = [];
  const tools = createAgentSearchTools({
    sources: sources.map(key => ({ key, querySeeds: ["backend engineer"] })),
    goal: { criteria: { ...defaultCriteria, locations: ["Remote"] }, enabledSources: sources },
    budget: { targetUniqueJobs: 200, maxSearchCalls: 20, maxTotalResults: 100, minSearchesPerSource: 1 },
    createSourceTools: options => {
      const source = options.source ?? "freehire";
      return createScrapeTools({
        ...options,
        fetcher: async () => {
          adapterCalls.push(source);
          return new Response(source === "ycombinator-remote"
            ? '<li><a href="/companies/example/jobs/yc-floor">Backend Engineer</a></li>'
            : '<a data-jk="indeed-floor-0">Backend Engineer</a>');
        },
        runCli: async () => {
          adapterCalls.push(source);
          const sourceIndex = sources.findIndex(candidate => candidate === source);
          const availableHits = sourceIndex < 4 ? 25 : 1;
          const results = Array.from({ length: availableHits }, (_, hitIndex) => {
            const id = source === "linkedin" ? String(8_000_000 + hitIndex) : `${source}-floor-${hitIndex}`;
            const url = source === "linkedin"
              ? `https://www.linkedin.com/jobs/view/${id}`
              : source === "relocate-me"
                ? `https://relocate.me/jobs/${id}`
                : `https://jobs.example.test/${source}/floor-${hitIndex}`;
            return { id, title: "Backend Engineer", company: "Example", location: "Remote", url };
          });
          const result = source === "tokyodev" || source === "japan-dev" || source === "relocate-me"
            ? { count: results.length, results }
            : { meta: { count: results.length }, results };
          return { code: 0, stderr: "", stdout: JSON.stringify(result) };
        },
      });
    },
  });
  const limits: number[] = [];
  for (const [index, source] of sources.entries()) {
    const recommendation = tools.state.snapshot().nextSearch;
    assert.ok(recommendation);
    assert.equal(recommendation.source, source);
    assert.equal(recommendation.reason, "source_floor");
    const floorCallsRemaining = sources.length - index;
    const slotsBefore = tools.state.remaining.maxTotalResults;
    await tools.searchJobs.execute(`floor-${index}`, {
      source,
      query: recommendation.query,
      location: recommendation.location,
      limit: 25,
    }, undefined, undefined, undefined as never);
    const attempt = tools.state.attempts.at(-1)!;
    limits.push(attempt.requestedLimit ?? 0);
    assert.ok(slotsBefore - (attempt.requestedLimit ?? 0) >= floorCallsRemaining - 1);
    assert.ok(tools.state.remaining.maxTotalResults >= floorCallsRemaining - 1);
    if (index === 0) {
      await assert.rejects(
        tools.searchJobs.execute("non-floor", { source: "freehire", query: "alternate", location: "Remote", limit: 25 }, undefined, undefined, undefined as never),
        /source-floor capacity is reserved/i,
      );
    }
  }
  const snapshot = tools.state.snapshot();
  assert.deepEqual(adapterCalls, sources);
  assert.deepEqual(limits, [25, 25, 25, 22, 1, 1, 1]);
  assert.equal(snapshot.discoveredCount, 100);
  assert.equal(snapshot.remaining.maxTotalResults, 0);
  assert.deepEqual(snapshot.attempts.filter(attempt => attempt.status === "completed").map(attempt => attempt.source), sources);
  assert.deepEqual(snapshot.sourceCoverage, { required: sources, searched: sources, unavailable: [], unsearched: [] });
  assert.equal(snapshot.plannerStop, "budget_exhausted");
});

test("source-floor reservations account only for remaining search calls", () => {
  const sources = [...jobSourceKeys];
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: sources },
    budget: { targetUniqueJobs: 200, maxSearchCalls: 4, maxTotalResults: 8, minSearchesPerSource: 1 },
    adaptive: true,
    querySeeds: new Map(sources.map(source => [source, ["backend engineer"]] as const)),
  });
  const limits: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const source = sources[index]!;
    const recommendation = state.snapshot().nextSearch!;
    assert.equal(recommendation.source, source);
    const reservation = state.reserveSearch({
      source,
      query: recommendation.query,
      location: recommendation.location,
      limit: 25,
    });
    limits.push(reservation.limit);
    state.completeSearch(reservation, Array.from({ length: reservation.limit }, (_, hitIndex) =>
      sourceFloorHit(source, `reachable-${index}-${hitIndex}`),
    ));
  }
  assert.deepEqual(limits, [5, 1, 1, 1]);
  assert.equal(state.discoveredCount, 8);
  assert.equal(state.remaining.maxTotalResults, 0);
  assert.equal(state.remaining.maxSearchCalls, 0);
  assert.deepEqual(state.snapshot().sourceCoverage.unsearched, sources.slice(4));
});
test("exhausted source-call capacity releases unfulfillable search floors", () => {
  const exhaustedSource: JobSource = "freehire";
  const availableSource: JobSource = "linkedin";
  const queries: [string, string, string] = ["backend engineer", "platform engineer", "data engineer"];
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: [exhaustedSource, availableSource] },
    budget: {
      maxSearchCalls: 6,
      maxTotalResults: 20,
      minSearchesPerSource: 2,
      maxSearchesPerSource: 3,
      maxQueryVariantsPerSource: 3,
    },
    adaptive: true,
    querySeeds: {
      [exhaustedSource]: queries,
      [availableSource]: queries,
    },
  });
  const search = (source: JobSource, query: string) => state.reserveSearch({ source, query, location: "", limit: 1 });
  state.completeSearch(search(exhaustedSource, queries[0]), []);
  for (const query of queries.slice(1)) state.failSearch(search(exhaustedSource, query), new Error("fixture failure"));
  assert.equal(state.attempts.filter(attempt => attempt.source === exhaustedSource && attempt.status === "completed").length, 1);
  assert.equal(state.attempts.filter(attempt => attempt.source === exhaustedSource && attempt.status !== "rejected").length, 3);

  for (const query of queries.slice(0, 2)) state.completeSearch(search(availableSource, query), []);
  const followUp = state.snapshot().nextSearch;
  assert.ok(followUp);
  assert.deepEqual(
    { source: followUp.source, query: followUp.query },
    { source: availableSource, query: queries[2] },
  );
  state.completeSearch(search(availableSource, followUp.query), []);
  assert.equal(state.finish("The global search-call budget is exhausted.", [], "budget_exhausted")?.reasonCategory, "budget_exhausted");
});

test("source request quotas release adaptive floor capacity after detail calls", async () => {
  const hits = Array.from({ length: 9 }, (_, index) => ({
    id: `relocate-${index}`,
    source: "relocate-me",
    title: "Backend Engineer",
    company: "Example",
    location: "Remote",
    url: `https://relocate.me/spain/example/backend-${index}`,
  }));
  const tools = createAgentSearchTools({
    sources: [
      { key: "relocate-me", querySeeds: ["backend", "platform"] },
      { key: "freehire", querySeeds: ["backend"] },
    ],
    budget: { maxSearchCalls: 2, maxDetailCalls: 9, maxTotalResults: 20, minSearchesPerSource: 2, maxSearchesPerSource: 3 },
    createSourceTools: sourceFactory(async args => {
      if (args[0] === "search" && args[args.indexOf("--source") + 1] === "relocate-me") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ count: hits.length, results: hits }) };
      }
      if (args[0] === "detail") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ url: args[1], title: "Backend Engineer", text: "Build reliable APIs." }) };
      }
      throw new Error("Unexpected fixture request.");
    }),
  });
  const search = textResult(await tools.searchJobs.execute("relocate-search", { source: "relocate-me", query: "backend", location: "", limit: 9 }, undefined, undefined, undefined as never));
  for (const hit of search.hits as Array<{ sourceId: string }>) {
    await tools.fetchJobDetails.execute(`detail-${hit.sourceId}`, { source: "relocate-me", resultId: hit.sourceId }, undefined, undefined, undefined as never);
  }

  assert.equal(tools.state.sourceStats.get("relocate-me")?.searchCalls, 1);
  assert.equal(tools.state.sourceStats.get("relocate-me")?.detailCalls, 9);
  await assert.rejects(
    tools.searchJobs.execute("relocate-exhausted", { source: "relocate-me", query: "platform", location: "", limit: 1 }, undefined, undefined, undefined as never),
    /source request capacity exhausted/,
  );
  assert.equal(tools.state.remaining.maxSearchCalls, 1);
  assert.equal(tools.state.snapshot().nextSearch?.source, "freehire");
});

test("adaptive source floors leave result slots for productive follow-up allocation", () => {
  const sources = [...jobSourceKeys];
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: sources },
    budget: { targetUniqueJobs: 200, maxSearchCalls: 20, maxTotalResults: 100, minSearchesPerSource: 1 },
    adaptive: true,
    querySeeds: new Map(sources.map(source => [source, source === "freehire" ? ["backend engineer", "platform engineer"] : ["backend engineer"]] as const)),
  });
  for (const source of sources) {
    const recommendation = state.snapshot().nextSearch;
    assert.ok(recommendation);
    assert.equal(recommendation.source, source);
    assert.equal(recommendation.reason, "source_floor");
    const hits = source === "freehire"
      ? Array.from({ length: 3 }, (_, index) => sourceFloorHit(source, `floor-${index}`))
      : [];
    state.completeSearch(state.reserveSearch({ source, query: recommendation.query, location: recommendation.location, limit: 25 }), hits);
  }
  assert.equal(state.remaining.maxTotalResults, 97);
  const recommendation = state.snapshot().nextSearch;
  assert.deepEqual(
    recommendation && { source: recommendation.source, query: recommendation.query, reason: recommendation.reason },
    { source: "freehire", query: "platform engineer", reason: "exploit_source" },
  );
  assert.ok(recommendation);
  const followUp = state.reserveSearch({ source: recommendation.source, query: recommendation.query, location: recommendation.location, limit: 25 });
  assert.equal(followUp.limit, 25);
  state.completeSearch(followUp, Array.from({ length: 25 }, (_, index) => sourceFloorHit("freehire", `follow-up-${index}`)));
  assert.equal(state.discoveredCount, 28);
  assert.equal(state.remaining.maxTotalResults, 72);
});

test("infeasible source floors remain visible when result and call budgets expire", () => {
  const sources = jobSourceKeys.slice(0, 3);
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: sources },
    budget: { targetUniqueJobs: 200, maxSearchCalls: 2, maxTotalResults: 2, minSearchesPerSource: 1 },
    adaptive: true,
    querySeeds: new Map(sources.map(source => [source, ["backend engineer"]] as const)),
  });
  assert.throws(() => state.finish("The search budget is exhausted.", [], "budget_exhausted"), /adaptive search still has viable work/i);
  for (const source of sources.slice(0, 2)) {
    const recommendation = state.snapshot().nextSearch;
    assert.ok(recommendation);
    assert.equal(recommendation.source, source);
    assert.equal(recommendation.reason, "source_floor");
    const reservation = state.reserveSearch({ source, query: recommendation.query, location: recommendation.location, limit: 25 });
    assert.equal(reservation.limit, 1);
    state.completeSearch(reservation, [sourceFloorHit(source, `infeasible-${source}`)]);
  }
  const exhausted = state.snapshot();
  assert.equal(exhausted.plannerStop, "budget_exhausted");
  assert.equal(exhausted.remaining.maxSearchCalls, 0);
  assert.equal(exhausted.remaining.maxTotalResults, 0);
  assert.deepEqual(exhausted.sourceCoverage.unsearched, [sources[2]]);
  assert.equal(state.finish("The search budget is exhausted.", [], "budget_exhausted")?.reasonCategory, "budget_exhausted");
  assert.deepEqual(state.snapshot().sourceCoverage.unsearched, [sources[2]]);
});

test("a failed first source is unavailable without blocking a healthy source floor", () => {
  const sources = jobSourceKeys.slice(0, 2);
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: sources },
    budget: { targetUniqueJobs: 20, maxSearchCalls: 3, maxTotalResults: 10, minSearchesPerSource: 1 },
    adaptive: true,
    querySeeds: new Map(sources.map(source => [source, ["backend engineer"]] as const)),
  });
  const first = state.snapshot().nextSearch;
  assert.ok(first);
  assert.deepEqual({ source: first.source, reason: first.reason }, { source: "freehire", reason: "source_floor" });
  state.failSearch(state.reserveSearch({ source: first.source, query: first.query, location: first.location, limit: 25 }), new Error("source unavailable"));
  const healthy = state.snapshot().nextSearch;
  assert.ok(healthy);
  assert.deepEqual({ source: healthy.source, reason: healthy.reason }, { source: "linkedin", reason: "source_floor" });
  state.completeSearch(state.reserveSearch({ source: healthy.source, query: healthy.query, location: healthy.location, limit: 25 }), []);
  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.sourceCoverage, {
    required: sources,
    searched: sources,
    unavailable: ["freehire"],
    unsearched: [],
  });
  assert.deepEqual(snapshot.attempts.map(attempt => [attempt.source, attempt.status]), [["freehire", "failed"], ["linkedin", "completed"]]);
});

test("adaptive pagination follows cursors and enforces path caps", () => {
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria, locations: ["Remote"] }, enabledSources: ["freehire"] },
    budget: { targetUniqueJobs: 50, maxSearchCalls: 8, maxTotalResults: 30, maxSearchesPerSource: 5, maxPagesPerQuery: 2, maxQueryVariantsPerSource: 2 },
    adaptive: true,
    querySeeds: { freehire: ["backend", "platform"] },
    sourceCapabilities: { freehire: true },
  });
  const first = state.reserveSearch({ source: "freehire", query: "backend", location: "Remote", limit: 25 });
  state.completeSearch(first, [{
    source: "freehire",
    sourceId: "fh-1",
    title: "Backend Engineer",
    company: "Example",
    location: "Remote",
    url: "https://jobs.example.test/fh-1",
  }], { hasMore: true, nextCursor: "cursor-2", total: 4 });
  assert.deepEqual(state.snapshot().nextSearch, {
    source: "freehire",
    query: "backend",
    location: "Remote",
    limit: 25,
    cursor: "cursor-2",
    reason: "paginate",
  });
  const second = state.reserveSearch({ source: "freehire", query: "backend", location: "Remote", limit: 25, cursor: "cursor-2" });
  assert.equal(state.attempts.at(-1)?.repeatCount, 0);
  state.completeSearch(second, [], { hasMore: true, nextCursor: "cursor-3", total: 4 });
  assert.throws(
    () => state.reserveSearch({ source: "freehire", query: "backend", location: "Remote", limit: 25, cursor: "cursor-3" }),
    /maxPagesPerQuery/i,
  );
  const variant = state.reserveSearch({ source: "freehire", query: "platform", location: "Remote", limit: 25 });
  state.completeSearch(variant, []);
  assert.throws(
    () => state.reserveSearch({ source: "freehire", query: "another", location: "Remote", limit: 25 }),
    /maxQueryVariantsPerSource/i,
  );
});
