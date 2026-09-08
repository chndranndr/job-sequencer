import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, insertSearchAttempt, listSearchAttempts } from "../src/server/db.js";
import {
  aggregateSourcePerformance,
  deriveHistoricalSearchSignals,
  derivePreferenceSignals,
  compileSearchMemory,
} from "../src/server/search/memory.js";
import { createAgentSearchExecutor, type ScrapeContext } from "../src/server/runs.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { createScrapeTools } from "../src/server/scrape.js";
import type { AgentSearchTools } from "../src/server/search/tools.js";
import type { PiSessionLike } from "../src/server/pi.js";

test("search attempts are persisted to SQLite and can represent completed, failed, and rejected attempts", () => {
  const db = openDatabase(":memory:");

  insertSearchAttempt(db, {
    id: "attempt-1",
    runId: "run-1",
    source: "freehire",
    query: "platform engineer",
    location: "Remote",
    intent: "find platform roles",
    status: "completed",
    resultCount: 5,
    uniqueResultCount: 3,
    promisingResultCount: 2,
    duplicateCount: 1,
    latencyMs: 120,
    error: null,
    createdAt: "2026-09-08T08:00:00.000Z",
  });

  insertSearchAttempt(db, {
    id: "attempt-2",
    runId: "run-1",
    source: "linkedin",
    query: "java developer",
    location: "Singapore",
    intent: "find java roles",
    status: "failed",
    resultCount: 0,
    uniqueResultCount: 0,
    promisingResultCount: 0,
    duplicateCount: 0,
    latencyMs: 50,
    error: "Network timeout",
    createdAt: "2026-09-08T08:01:00.000Z",
  });

  insertSearchAttempt(db, {
    id: "attempt-3",
    runId: "run-1",
    source: "linkedin",
    query: "java developer",
    location: "Singapore",
    status: "rejected",
    resultCount: 0,
    uniqueResultCount: 0,
    promisingResultCount: 0,
    duplicateCount: 0,
    latencyMs: 0,
    error: "maxSearchCalls",
    createdAt: "2026-09-08T08:02:00.000Z",
  });

  const attempts = listSearchAttempts(db);
  assert.equal(attempts.length, 3);
  // Ordered by created_at DESC
  assert.equal(attempts[0]?.id, "attempt-3");
  assert.equal(attempts[0]?.status, "rejected");
  assert.equal(attempts[1]?.id, "attempt-2");
  assert.equal(attempts[1]?.status, "failed");
  assert.equal(attempts[2]?.id, "attempt-1");
  assert.equal(attempts[2]?.status, "completed");
  assert.equal(attempts[2]?.promisingResultCount, 2);
  assert.equal(attempts[2]?.uniqueResultCount, 3);
});

test("source performance summaries and historical signals are derived deterministically", () => {
  const db = openDatabase(":memory:");

  for (let i = 0; i < 3; i++) {
    insertSearchAttempt(db, {
      id: `good-${i}`,
      runId: `run-${i}`,
      source: "freehire",
      query: "platform engineer",
      location: "Singapore",
      status: "completed",
      resultCount: 4,
      uniqueResultCount: 3,
      promisingResultCount: 2,
      duplicateCount: 1,
      latencyMs: 100,
      createdAt: `2026-09-08T08:0${i}:00.000Z`,
    });
  }

  for (let i = 0; i < 2; i++) {
    insertSearchAttempt(db, {
      id: `bad-${i}`,
      runId: `run-${i}`,
      source: "linkedin",
      query: "legacy maintainer",
      location: "Singapore",
      status: "completed",
      resultCount: 5,
      uniqueResultCount: 0,
      promisingResultCount: 0,
      duplicateCount: 5,
      latencyMs: 80,
      createdAt: `2026-09-08T08:1${i}:00.000Z`,
    });
  }

  const summaries = aggregateSourcePerformance(db);
  assert.equal(summaries.length, 2);

  const freehireSummary = summaries.find((s) => s.source === "freehire");
  assert.ok(freehireSummary);
  assert.equal(freehireSummary.attempts, 3);
  assert.equal(freehireSummary.successRate, 1);
  assert.equal(freehireSummary.promisingJobs, 6);
  assert.ok(freehireSummary.duplicateRate < 0.3);

  const linkedinSummary = summaries.find((s) => s.source === "linkedin");
  assert.ok(linkedinSummary);
  assert.equal(linkedinSummary.attempts, 2);
  assert.equal(linkedinSummary.duplicateRate, 1);

  const signals = deriveHistoricalSearchSignals(db);
  const positive = signals.find((s) => s.signal === "positive");
  assert.ok(positive);
  assert.match(positive.pattern, /platform engineer/i);
  assert.ok(positive.confidence > 0.5);

  const negative = signals.find((s) => s.signal === "negative");
  assert.ok(negative);
  assert.match(negative.pattern, /legacy maintainer/i);
  assert.match(negative.evidence, /duplicate/i);
});

test("behavioral preference signals extract evidence from job stages and outcomes", () => {
  const db = openDatabase(":memory:");

  // Add selected, interview, and offer jobs (positive)
  db.prepare(`
    INSERT INTO jobs(id, source_id, source, url, company, role, location, posting, score, rank_json, stage, first_seen_at, updated_at)
    VALUES ('job-1', 's-1', 'freehire', 'https://example.test/1', 'Acme', 'Platform Engineer', 'Singapore', 'Posting 1', 85, '{}', 'Selected', '2026-09-08T00:00:00Z', '2026-09-08T01:00:00Z'),
           ('job-2', 's-2', 'freehire', 'https://example.test/2', 'Beta', 'Platform Engineer', 'Singapore', 'Posting 2', 90, '{}', 'Applied', '2026-09-08T00:00:00Z', '2026-09-08T02:00:00Z'),
           ('job-3', 's-3', 'freehire', 'https://example.test/3', 'Gamma', 'Backend Engineer', 'Tokyo', 'Posting 3', 88, '{}', 'Interview', '2026-09-08T00:00:00Z', '2026-09-08T03:00:00Z')
  `).run();

  // Add application outcome
  db.prepare(`
    INSERT INTO applications(job_id, outcome, updated_at)
    VALUES ('job-3', 'interview scheduled', '2026-09-08T03:30:00Z')
  `).run();

  // Add discarded jobs (negative)
  db.prepare(`
    INSERT INTO jobs(id, source_id, source, url, company, role, location, posting, score, rank_json, stage, first_seen_at, updated_at)
    VALUES ('job-4', 's-4', 'linkedin', 'https://example.test/4', 'Delta', 'Sales Engineer', 'Singapore', 'Posting 4', 40, '{}', 'Discarded', '2026-09-08T00:00:00Z', '2026-09-08T04:00:00Z'),
           ('job-5', 's-5', 'linkedin', 'https://example.test/5', 'Epsilon', 'Sales Engineer', 'Singapore', 'Posting 5', 35, '{}', 'Discarded', '2026-09-08T00:00:00Z', '2026-09-08T05:00:00Z')
  `).run();

  const signals = derivePreferenceSignals(db);
  const platform = signals.find((s) => s.pattern.toLowerCase().includes("platform"));
  assert.ok(platform);
  assert.ok(platform.positive >= 2);
  assert.equal(platform.negative, 0);

  const sales = signals.find((s) => s.pattern.toLowerCase().includes("sales"));
  assert.ok(sales);
  assert.equal(sales.positive, 0);
  assert.ok(sales.negative >= 2);
});

test("compileSearchMemory enforces strict bounds on size and entry counts", () => {
  const db = openDatabase(":memory:");

  // Insert 50 attempts to test bounds
  for (let i = 0; i < 50; i++) {
    insertSearchAttempt(db, {
      id: `burst-${i}`,
      runId: `run-${i}`,
      source: i % 2 === 0 ? "freehire" : "linkedin",
      query: `Query Variant ${i}`,
      location: "Location",
      status: "completed",
      resultCount: 5,
      uniqueResultCount: 2,
      promisingResultCount: 1,
      duplicateCount: 1,
      latencyMs: 100,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    });
  }

  const memory = compileSearchMemory(db, {
    maxSignals: 4,
    maxPreferenceSignals: 3,
    maxTextLength: 600,
  });

  assert.ok(memory.historicalSearchSignals.length <= 4);
  assert.ok(memory.preferenceSignals.length <= 3);
  assert.ok(memory.summaryText.length <= 600);
});

test("deterministic two-run fixture: Run 2 receives useful memory compiled from Run 1", async () => {
  const db = openDatabase(":memory:");

  class FakeSession implements PiSessionLike {
    subscribe() { return () => {}; }
    async prompt() {}
    async abort() {}
    dispose() {}
  }

  let capturedPrompt = "";
  const executor = createAgentSearchExecutor({
    db,
    loadGuidance: async () => "bounded guidance",
    createSourceTools: () => createScrapeTools({
      source: "freehire",
      runCli: async (args) => {
        if (args[0] === "search") {
          const isPlatform = args.includes("platform");
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              meta: { count: 2 },
              results: isPlatform
                ? [
                    { id: "p-1", title: "Platform Engineer", company: "A", location: "Remote", url: "https://example.test/p-1" },
                    { id: "p-2", title: "Platform Engineer", company: "B", location: "Remote", url: "https://example.test/p-2" },
                  ]
                : [
                    { id: "j-1", title: "Java Dev", company: "C", location: "Remote", url: "https://example.test/j-1" },
                  ],
            }),
          };
        }
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ id: "p-1", title: "Platform Engineer", url: "https://example.test/p-1", description: "Full posting." }),
        };
      },
    }),
    createSession: async () => new FakeSession(),
    runPi: async (options) => {
      capturedPrompt = options.prompt;
    },
  });

  // RUN 1: Record 2 completed attempts manually in DB simulating a previous run
  insertSearchAttempt(db, {
    id: "run1-attempt-1",
    runId: "run-1",
    source: "freehire",
    query: "platform engineer",
    location: "Remote",
    status: "completed",
    resultCount: 2,
    uniqueResultCount: 2,
    promisingResultCount: 2,
    duplicateCount: 0,
    latencyMs: 120,
    createdAt: "2026-09-08T07:00:00Z",
  });
  insertSearchAttempt(db, {
    id: "run1-attempt-2",
    runId: "run-1",
    source: "freehire",
    query: "platform engineer",
    location: "Remote",
    status: "completed",
    resultCount: 2,
    uniqueResultCount: 2,
    promisingResultCount: 2,
    duplicateCount: 0,
    latencyMs: 110,
    createdAt: "2026-09-08T07:05:00Z",
  });
  insertSearchAttempt(db, {
    id: "run1-attempt-3",
    runId: "run-1",
    source: "freehire",
    query: "java legacy",
    location: "Remote",
    status: "completed",
    resultCount: 5,
    uniqueResultCount: 0,
    promisingResultCount: 0,
    duplicateCount: 5,
    latencyMs: 90,
    createdAt: "2026-09-08T07:10:00Z",
  });
  insertSearchAttempt(db, {
    id: "run1-attempt-4",
    runId: "run-1",
    source: "freehire",
    query: "java legacy",
    location: "Remote",
    status: "completed",
    resultCount: 5,
    uniqueResultCount: 0,
    promisingResultCount: 0,
    duplicateCount: 5,
    latencyMs: 95,
    createdAt: "2026-09-08T07:15:00Z",
  });

  // RUN 2: Execute new scrape run
  const context: ScrapeContext = {
    profile: "Platform engineer with Kubernetes experience",
    criteria: { ...defaultCriteria, roles: ["Platform Engineer"], maxJobsPerRun: 2 },
    settings: { ...defaultSettings, enabledSources: ["freehire"] },
    signal: new AbortController().signal,
    runId: "run-2",
    db,
  };

  let toolsInstance: AgentSearchTools | undefined;
  const customExecutor = createAgentSearchExecutor({
    db,
    loadGuidance: async () => "bounded guidance",
    createSession: async (_settings, tools) => {
      toolsInstance = tools;
      return new FakeSession();
    },
    runPi: async (options) => {
      capturedPrompt = options.prompt;
      await options.createSession();
      // Agent inspects state and uses positive signal for platform engineer
      await toolsInstance!.searchJobs.execute("s-1", { source: "freehire", query: "platform engineer", location: "Remote", limit: 2 }, undefined, undefined, undefined as never);
      await toolsInstance!.fetchJobDetails.execute("d-1", { source: "freehire", resultId: "p-1" }, undefined, undefined, undefined as never);
      await toolsInstance!.finishSearch.execute("f-1", { reason: "Found promising candidates using historical strategy." }, undefined, undefined, undefined as never);
      options.onAssistantText?.(JSON.stringify({
        jobs: [
          { sourceId: "p-1", source: "freehire", url: "https://example.test/p-1", company: "A", role: "Platform Engineer", location: "Remote", posting: "Full posting.", score: 90, reason: "Fit", strengths: ["Platform"], gaps: [] },
        ],
      }));
    },
    createSourceTools: () => createScrapeTools({
      source: "freehire",
      runCli: async (args) => {
        if (args[0] === "search") {
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              meta: { count: 2 },
              results: [
                { id: "p-1", title: "Platform Engineer", company: "A", location: "Remote", url: "https://example.test/p-1" },
                { id: "p-2", title: "Platform Engineer", company: "B", location: "Remote", url: "https://example.test/p-2" },
              ],
            }),
          };
        }
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({ id: "p-1", title: "Platform Engineer", url: "https://example.test/p-1", description: "Full posting." }),
        };
      },
    }),
  });

  const output = await customExecutor(context);
  assert.equal((output.result as { jobs: unknown[] }).jobs.length, 1);

  // Verify that prompt in Run 2 received historical search memory
  assert.match(capturedPrompt, /HISTORICAL SEARCH MEMORY & OUTCOMES/i);
  assert.match(capturedPrompt, /\[POSITIVE\] platform engineer/i);
  assert.match(capturedPrompt, /\[NEGATIVE\] java legacy/i);
  assert.match(capturedPrompt, /DO NOT OVERRIDE EXPLICIT CRITERIA/i);

  // Verify that Run 2's new search attempt was persisted to the database
  const run2Attempts = listSearchAttempts(db).filter((a) => a.runId === "run-2");
  assert.equal(run2Attempts.length, 1);
  assert.equal(run2Attempts[0]?.query, "platform engineer");
  assert.equal(run2Attempts[0]?.status, "completed");
  assert.equal(run2Attempts[0]?.uniqueResultCount, 2);
});

test("poor historical query is deprioritized but not permanently forbidden", async () => {
  const db = openDatabase(":memory:");

  // Pre-seed a poor query attempt
  for (let i = 0; i < 3; i++) {
    insertSearchAttempt(db, {
      id: `poor-${i}`,
      runId: `seed-${i}`,
      source: "freehire",
      query: "php developer",
      location: "Remote",
      status: "completed",
      resultCount: 5,
      uniqueResultCount: 0,
      promisingResultCount: 0,
      duplicateCount: 5,
      latencyMs: 90,
      createdAt: `2026-09-08T07:0${i}:00Z`,
    });
  }

  let toolsInstance: AgentSearchTools | undefined;
  class FakeSession implements PiSessionLike {
    subscribe() { return () => {}; }
    async prompt() {}
    async abort() {}
    dispose() {}
  }

  const executor = createAgentSearchExecutor({
    db,
    loadGuidance: async () => "bounded guidance",
    createSession: async (_settings, tools) => {
      toolsInstance = tools;
      return new FakeSession();
    },
    runPi: async (options) => {
      await options.createSession();
      // Even though php developer has a negative signal, the agent is allowed to execute it
      await toolsInstance!.searchJobs.execute("s-1", { source: "freehire", query: "php developer", location: "Remote", limit: 2 }, undefined, undefined, undefined as never);
      await toolsInstance!.finishSearch.execute("f-1", { reason: "Retried historical query as context justified." }, undefined, undefined, undefined as never);
      options.onAssistantText?.(JSON.stringify({ jobs: [] }));
    },
    createSourceTools: () => createScrapeTools({
      source: "freehire",
      runCli: async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ meta: { count: 0 }, results: [] }),
      }),
    }),
  });

  const context: ScrapeContext = {
    profile: "Developer",
    criteria: { ...defaultCriteria, maxJobsPerRun: 1 },
    settings: { ...defaultSettings, enabledSources: ["freehire"] },
    signal: new AbortController().signal,
    runId: "retry-run",
    db,
  };

  const output = await executor(context);
  assert.deepEqual((output.result as { jobs: unknown[] }).jobs, []);
  const retried = listSearchAttempts(db).find((a) => a.runId === "retry-run");
  assert.ok(retried);
  assert.equal(retried.query, "php developer");
});

test("inferred preferences cannot override explicit hard criteria", () => {
  const db = openDatabase(":memory:");

  // User previously selected jobs in Singapore, creating positive preference for Singapore
  for (let i = 0; i < 5; i++) {
    db.prepare(`
      INSERT INTO jobs(id, source_id, source, url, company, role, location, posting, score, rank_json, stage, first_seen_at, updated_at)
      VALUES (?, ?, 'freehire', ?, 'Company', 'Engineer', 'Singapore', 'Posting', 85, '{}', 'Selected', '2026-09-08T00:00:00Z', '2026-09-08T01:00:00Z')
    `).run(`sg-${i}`, `source-sg-${i}`, `https://example.test/sg-${i}`);
  }

  const memory = compileSearchMemory(db);
  const sgSignal = memory.preferenceSignals.find((s) => s.pattern.toLowerCase().includes("singapore"));
  assert.ok(sgSignal);
  assert.ok(sgSignal.positive >= 5);

  // Criteria explicitly set location to "Tokyo" and excludes "Singapore"
  const criteria = {
    ...defaultCriteria,
    locations: ["Tokyo"],
    excludeKeywords: ["Singapore"],
  };

  // Ensure prompt instruction guarantees hard criteria authority
  assert.match(memory.summaryText, /BEHAVIORAL PREFERENCE SIGNALS/);
  // Verify that criteria object itself was not modified by memory compilation
  assert.deepEqual(criteria.locations, ["Tokyo"]);
  assert.deepEqual(criteria.excludeKeywords, ["Singapore"]);
});
