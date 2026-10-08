import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserDiscoveryExecutor, createBrowserDiscoveryTools } from "../src/server/browser-discovery.js";
import { createRestrictedScrapeSession, runBoundedPi } from "../src/server/pi.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { deriveRunTrajectoryObservability } from "../src/trajectory.js";

const career = "https://company.example/careers";
const posting = "https://company.example/careers/backend";
const signal = new AbortController().signal;
const signedUrls = [
  "https://company.example/careers?sig=fixture-signature",
  "https://company.example/careers?signature=fixture-signature",
  "https://company.example/careers?X-Amz-Signature=fixture-signature",
  "https://company.example/careers?X-Goog-Signature=fixture-signature",
  "https://company.example/careers?X-Hub-Signature=fixture-signature",
];
function fixture(includePostingMetadata = true) {
  const calls: string[][] = [];
  let current = "";
  const command = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "session" && args[1] === "start") return { session_id: "fixture-session" };
    if (args[0] === "session" && args[1] === "stop") return { stopped: ["fixture-session"], failed: [] };
    if (args[0] === "navigate") { current = args[1]!; return { final_url: current }; }
    if (args[0] === "observe") return { text: "Public careers content" };
    if (args[0] === "evaluate") return { ok: true, value: {
      url: current, title: current === posting ? "Backend Engineer" : "Careers", text: "Backend Engineer. Location: Remote. Build Java APIs.",
      links: current.includes("google.com")
        ? [{ url: career, title: "Company careers" }, ...signedUrls.map(url => ({ url, title: "Signed URL" })), { url: "https://www.ziprecruiter.com./jobs/123", title: "External job board" }, { url: "https://company.example/oauth/callback?code=fixture-authorization-code", title: "OAuth callback" }, { url: "http://127.0.0.1/admin", title: "Private" }]
        : [{ url: posting, title: "Backend Engineer" }],
      postings: current === posting && includePostingMetadata ? [{ title: "Backend Engineer", company: "Company", location: "Remote" }] : [],
    } };
    return {};
  };
  return { command, calls };
}

test("web discovery follows observed career links and records only read postings", async () => {
  const { command, calls } = fixture();
  const tools = await createBrowserDiscoveryTools({ command, validateDestination: async () => {} });
  try {
    const search = tools.allTools.find(tool => tool.name === "searchWeb")!;
    const read = tools.allTools.find(tool => tool.name === "readWebPage")!;
    const searchResult = await search.execute("search", { query: "Java backend careers" }, signal, undefined, undefined as never);
    assert.match(searchResult.content.find(item => item.type === "text")?.text ?? "", /company\.example\/careers/);
    assert.doesNotMatch(searchResult.content.find(item => item.type === "text")?.text ?? "", /ziprecruiter|authorization-code|127\.0\.0\.1/i);
    assert.equal(tools.provenance.size, 0);
    await assert.rejects(() => read.execute("unknown", { url: "https://unknown.example/job" }, signal, undefined, undefined as never), /observed/);
    await assert.rejects(() => read.execute("private", { url: "http://127.0.0.1/admin" }, signal, undefined, undefined as never), /private|local/);
    await read.execute("career", { url: career }, signal, undefined, undefined as never);
    await read.execute("job", { url: posting }, signal, undefined, undefined as never);
    const item = [...tools.evidence.values()].find(value => value.url === posting)!;
    assert.equal(item.company, "Company");
    assert.equal(item.location, "Remote");
    assert.ok(item.posting?.includes("Java APIs"));
    assert.ok(tools.provenance.has(`web-discovery\0${item.sourceId}`));
    await assert.rejects(() => read.execute("repeat", { url: posting }, signal, undefined, undefined as never), /already/);
  } finally { await tools.close(); }
  assert.deepEqual(calls.at(-1), ["session", "stop", "fixture-session", "--json"]);
});

test("web discovery omits signed credential URLs and rejects them before navigation", async () => {
  const { command, calls } = fixture();
  const tools = await createBrowserDiscoveryTools({ command, validateDestination: async () => {} });
  try {
    const search = tools.allTools.find(tool => tool.name === "searchWeb")!;
    const read = tools.allTools.find(tool => tool.name === "readWebPage")!;
    const result = await search.execute("search", { query: "Java backend careers" }, signal, undefined, undefined as never);
    const text = result.content.find(item => item.type === "text")?.text ?? "";
    for (const url of signedUrls) {
      assert.equal(text.includes(url), false);
      await assert.rejects(() => read.execute("signed", { url }, signal, undefined, undefined as never), /Credential-bearing/);
      assert.equal(calls.some(args => args[0] === "navigate" && args[1] === url), false);
    }
    assert.equal(tools.provenance.size, 0);
  } finally { await tools.close(); }
});

test("web discovery blocks candidate identifiers before Google search and trace", async () => {
  const { command, calls } = fixture();
  const profile = JSON.stringify({
    identity: { firstName: "Mira", lastName: "Solano", email: "mira.solano@example.test", phone: "+1-415-555-0137", city: "Riverton" },
    experience: [{ currentRole: true, company: "Northstar Labs", title: "Principal Java Engineer", description: "Built reliable payment APIs." }],
  });
  const trace: Array<{ type: string; payload?: unknown }> = [];
  let modelPrompt = "";
  let runFixture: (emit: (event: unknown) => void) => Promise<string> = async () => { throw new Error("Browser fixture was not prepared."); };
  const runPi: typeof runBoundedPi = options => runBoundedPi({
    ...options,
    createSession: async () => {
      let listener: ((event: unknown) => void) | undefined;
      return {
        subscribe: next => {
          listener = next;
          return () => { listener = undefined; };
        },
        prompt: async prompt => {
          modelPrompt = prompt;
          const output = await runFixture(event => listener?.(event));
          listener?.({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: output } });
        },
        abort: async () => {},
        dispose: () => {},
      };
    },
  });
  const execute = createBrowserDiscoveryExecutor({
    createTools: async options => {
      const tools = await createBrowserDiscoveryTools({ ...options, command, validateDestination: async () => {} });
      runFixture = async emit => {
        const search = tools.allTools.find(tool => tool.name === "searchWeb")!;
        const read = tools.allTools.find(tool => tool.name === "readWebPage")!;
        const privateQueries = [
          "Mira Solano Java backend jobs",
          "jobs for mira.solano@example.test",
          "Java developer 415 555 0137",
          "Riverton software engineer jobs",
          "jobs at Northstar Labs",
        ];
        for (const [index, query] of privateQueries.entries()) {
          const toolCallId = `private-search-${index}`;
          emit({ type: "tool_execution_start", toolCallId, toolName: "searchWeb", args: { query } });
          await assert.rejects(() => search.execute(toolCallId, { query }, signal, undefined, undefined as never), /candidate identifiers/);
          emit({ type: "tool_execution_end", toolCallId, toolName: "searchWeb", result: { error: "Search queries must not contain candidate identifiers." }, isError: true });
        }
        const genericQuery = "Java backend careers";
        emit({ type: "tool_execution_start", toolCallId: "generic-search", toolName: "searchWeb", args: { query: genericQuery } });
        const searchResult = await search.execute("generic-search", { query: genericQuery }, signal, undefined, undefined as never);
        emit({ type: "tool_execution_end", toolCallId: "generic-search", toolName: "searchWeb", result: searchResult, isError: false });
        await read.execute("career", { url: career }, signal, undefined, undefined as never);
        await read.execute("posting", { url: posting }, signal, undefined, undefined as never);
        const item = [...tools.evidence.values()].find(value => value.url === posting)!;
        return JSON.stringify({ jobs: [{ sourceId: item.sourceId, source: "web-discovery", url: posting, company: "Company", role: "Backend Engineer", location: "Remote", posting: "invented text", score: 80, reason: "Java match", strengths: ["Java"], gaps: [] }] });
      };
      return tools;
    },
    runPi,
  });
  const previousTelemetryMode = process.env.TELEMETRY_MODE;
  process.env.TELEMETRY_MODE = "trace";
  try {
    await execute({
      profile,
      settings: { ...defaultSettings, scrapeMode: "web-discovery" },
      criteria: defaultCriteria,
      signal,
      runId: "privacy-run",
      trajectory: (_runId, event) => trace.push(event),
    });
  } finally {
    if (previousTelemetryMode === undefined) delete process.env.TELEMETRY_MODE;
    else process.env.TELEMETRY_MODE = previousTelemetryMode;
  }
  for (const value of ["Mira", "Solano", "mira.solano@example.test", "+1-415-555-0137", "Riverton", "Northstar Labs", "Principal Java Engineer", "Built reliable payment APIs."]) {
    assert.ok(modelPrompt.includes(value), `model prompt omitted ${value}`);
  }
  assert.ok(modelPrompt.includes("Candidate profile:"));
  const traceText = JSON.stringify(trace);
  assert.doesNotMatch(traceText, /Mira|Solano|mira\.solano@example\.test|415[- ]555[- ]0137|Riverton|Northstar Labs|Principal Java Engineer|Built reliable payment APIs\./);
  const promptEvent = trace.find(event => event.type === "user_prompt");
  assert.ok(promptEvent);
  assert.ok(JSON.stringify(promptEvent).includes("[candidate profile omitted from TRACE]"));
  assert.ok(traceText.includes("[candidate search omitted]"));
  assert.equal(trace.filter(event => event.type === "web_search_completed").length, 1);
  const googleNavigations = calls.filter(args => args[0] === "navigate" && args[1]?.startsWith("https://www.google.com/search"));
  assert.equal(googleNavigations.length, 1);
  assert.equal(new URL(googleNavigations[0]![1]!).searchParams.get("q")?.startsWith("Java backend careers"), true);
});

test("web discovery records a labeled visible remote location without structured posting metadata", async () => {
  const { command } = fixture(false);
  const tools = await createBrowserDiscoveryTools({ command, validateDestination: async () => {} });
  try {
    await tools.allTools[0]!.execute("search", { query: "Java careers" }, signal, undefined, undefined as never);
    await tools.allTools[1]!.execute("careers", { url: career }, signal, undefined, undefined as never);
    await tools.allTools[1]!.execute("posting", { url: posting }, signal, undefined, undefined as never);
    assert.equal([...tools.evidence.values()].find(item => item.url === posting)?.location, "Remote");
  } finally { await tools.close(); }
});

test("browser errors and zero-result searches cannot masquerade as successful discovery", async () => {
  const { command, calls } = fixture();
  const tools = await createBrowserDiscoveryTools({ command: async args => args[0] === "evaluate" ? { ok: false } : command(args), validateDestination: async () => {} });
  try {
    await assert.rejects(() => tools.allTools[0]!.execute("search", { query: "careers" }, signal, undefined, undefined as never), /read/);
    assert.equal(tools.provenance.size, 0);
  } finally { await tools.close(); }
  assert.equal(calls.at(-1)?.[1], "stop");
});

test("web discovery shares the restricted agent and returns source evidence, not invented posting text", async () => {
  const { command, calls } = fixture();
  const tools = await createBrowserDiscoveryTools({ command, validateDestination: async () => {} });
  const session = await createRestrictedScrapeSession(tools);
  try { assert.deepEqual(session.getActiveToolNames().sort(), ["readWebPage", "searchWeb"]); }
  finally { session.dispose(); }
  const runPi: typeof runBoundedPi = async options => {
    await tools.allTools[0]!.execute("search", { query: "Java careers" }, signal, undefined, undefined as never);
    await tools.allTools[1]!.execute("careers", { url: career }, signal, undefined, undefined as never);
    await tools.allTools[1]!.execute("posting", { url: posting }, signal, undefined, undefined as never);
    const item = [...tools.evidence.values()].find(value => value.url === posting)!;
    options.onAssistantText?.(JSON.stringify({ jobs: [{ sourceId: item.sourceId, source: "web-discovery", url: posting, company: "Company", role: "Backend Engineer", location: "Remote", posting: "invented text", score: 80, reason: "Java match", strengths: ["Java"], gaps: [] }] }));
    return undefined as never;
  };
  const execute = createBrowserDiscoveryExecutor({ createTools: async () => tools, runPi });
  const output = await execute({ profile: "Java engineer", settings: { ...defaultSettings, scrapeMode: "web-discovery" }, criteria: defaultCriteria, signal });
  const jobs = (output.result as { jobs: Array<{ posting: string }> }).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.posting, "Backend Engineer. Location: Remote. Build Java APIs.");
  assert.equal(calls.at(-1)?.[1], "stop");
});

test("failed or fabricated agent output closes the owned browser session", async () => {
  const { command, calls } = fixture();
  const tools = await createBrowserDiscoveryTools({ command, validateDestination: async () => {} });
  const execute = createBrowserDiscoveryExecutor({ createTools: async () => tools, runPi: async () => { throw new Error("cancelled fixture"); } });
  await assert.rejects(() => execute({ profile: "Engineer", settings: defaultSettings, criteria: defaultCriteria, signal }), /cancelled fixture/);
  assert.equal(calls.at(-1)?.[1], "stop");
});

test("TRACE counts browser discovery links and read pages", () => {
  const observed = deriveRunTrajectoryObservability({ workflow: "scrape", status: "succeeded", started_at: "2026-10-05T00:00:00.000Z", finished_at: "2026-10-05T00:01:00.000Z", error: null, input_tokens: null, output_tokens: null, total_tokens: null, estimated_cost: null }, [{ runId: "web-run", sequence: 1, kind: "lifecycle", type: "web_page_read", timestamp: "2026-10-05T00:00:00.000Z", startedAt: null, endedAt: null, durationMs: null, payload: { counts: { discovered: 10, unique: 10, enriched: 3 } } }]);
  assert.deepEqual(observed.counts, { discovered: 10, unique: 10, enriched: 3 });
});
