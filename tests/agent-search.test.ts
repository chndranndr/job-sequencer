import test from "node:test";
import assert from "node:assert/strict";
import { AllSourcesFailedError, createAgentSearchExecutor, type ScrapeContext } from "../src/server/runs.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { createScrapeTools } from "../src/server/scrape.js";
import { createAgentSearchTools, type AgentSearchTools } from "../src/server/search/tools.js";
import { AgentSearchState, SearchBudgetExceededError, SearchNotFinishedError } from "../src/server/search/state.js";
import type { PiSessionLike } from "../src/server/pi.js";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";

function textResult(value: unknown) {
  const content = (value as { content: Array<{ type: string; text?: string }> }).content;
  const block = content.find((item) => item.type === "text");
  if (!block?.text) throw new Error("tool returned no text");
  return JSON.parse(block.text) as Record<string, any>;
}

function sourceFactory(runCli: (args: string[]) => Promise<{ code: number; stderr: string; stdout: string }>) {
  return (options: Parameters<typeof createScrapeTools>[0]) => createScrapeTools({ ...options, runCli });
}

function makeAgentTools(runCli: (args: string[]) => Promise<{ code: number; stderr: string; stdout: string }>, budget: Record<string, number> = {}) {
  const state = new AgentSearchState({ goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire"] }, budget });
  return createAgentSearchTools({ state, sourceTools: new Map([["freehire", createScrapeTools({ source: "freehire", runCli })]]) });
}

const detail = (id: string, url: string) => ({ id, title: "Backend Engineer", url, description: "Full posting for the selected job." });

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
  const events: string[] = [];
  const state = new AgentSearchState({
    goal: { criteria: { ...defaultCriteria }, enabledSources: ["freehire", "linkedin"] },
    runId: "run-1",
    trajectory: (_runId, event) => { events.push(event.type); },
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
  await tools.finishSearch.execute("finish", { reason: "Enough evidence collected." }, undefined, undefined, undefined as never);
  assert.deepEqual(tools.provenance.get("freehire\u0000freehire-job"), "https://jobs.example.test/freehire");
  assert.ok(events.includes("search_started"));
  assert.ok(events.includes("search_completed"));
  assert.ok(events.includes("search_state_inspected"));
  assert.ok(events.includes("search_finished"));
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
      options.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: JSON.stringify({ jobs: [{ sourceId: "job-1", source: "freehire", url: "https://jobs.example.test/one", company: "Example", role: "Engineer", location: "Remote", posting: "metadata", score: 80, reason: "fit", strengths: [], gaps: [] }] }) } });
    },
  });
  const context = {
    profile: "Backend engineer",
    criteria: { ...defaultCriteria, maxJobsPerRun: 1 },
    settings: { ...defaultSettings, enabledSources: ["freehire"] },
    signal: new AbortController().signal,
  } satisfies ScrapeContext;
  const output = await run(context);
  assert.equal(sessionCount, 1);
  assert.doesNotMatch(prompt, /fetch every returned/i);
  assert.equal((output.result as { jobs: Array<{ posting: string }> }).jobs[0]?.posting, "Full posting for the selected job.");

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
    signal: new AbortController().signal,
  } satisfies ScrapeContext;
  await assert.rejects(run(context), AllSourcesFailedError);
});
