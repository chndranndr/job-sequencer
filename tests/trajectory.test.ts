import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildServer } from "../src/server/app.js";
import { appendRunTrajectoryEvent, createTaskReporter, createTrajectoryRecorder, listRunTrajectoryEvents, openDatabase } from "../src/server/db.js";
import { runBoundedPi, type PiSessionLike } from "../src/server/pi.js";
import { defaultCriteria, defaultSettings } from "../src/server/config.js";
import { createMultiSourceScrapeExecutor, RunManager } from "../src/server/runs.js";
import { deriveRunTaskRows } from "../src/shared.js";
import { deriveRunTrajectoryObservability } from "../src/trajectory.js";
import type { TrajectoryEvent } from "../src/shared.js";

function insertRun(db: ReturnType<typeof openDatabase>, id: string = randomUUID()) {
  db.prepare("INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES(?,?,?,?,?,?)").run(id, "test", "running", "fake", "fixture", "2026-08-20T00:00:00.000Z");
  return id;
}

test("trajectory rows are ordered per run, tolerate bad JSON, and cascade with the run", () => {
  const db = openDatabase(":memory:");
  try {
    const runId = insertRun(db, "trajectory-db");
    appendRunTrajectoryEvent(db, runId, { kind: "user", type: "user_prompt", timestamp: "2026-08-20T00:00:01.000Z", payload: { text: "first" } });
    appendRunTrajectoryEvent(db, runId, { kind: "assistant", type: "assistant_message", timestamp: "2026-08-20T00:00:02.000Z", payload: { text: "second" } });
    db.prepare("UPDATE run_trajectory_events SET payload_json=? WHERE run_id=? AND sequence=2").run("not-json", runId);
    const events = listRunTrajectoryEvents(db, runId);
    assert.deepEqual(events.map((event) => [event.sequence, event.type]), [[1, "user_prompt"], [2, "assistant_message"]]);
    assert.deepEqual(events[0]?.payload, { text: "first" });
    assert.equal(events[1]?.payload, null);
    db.prepare("DELETE FROM runs WHERE id=?").run(runId);
    assert.equal((db.prepare("SELECT count(*) AS count FROM run_trajectory_events WHERE run_id=?").get(runId) as { count: number }).count, 0);
  } finally { db.close(); }
});

test("trajectory API returns a stable envelope and a safe 404", async () => {
  const db = openDatabase(":memory:");
  const runId = insertRun(db, "trajectory-api");
  appendRunTrajectoryEvent(db, runId, { kind: "lifecycle", type: "run_started", payload: null });
  appendRunTrajectoryEvent(db, runId, { kind: "lifecycle", type: "search_started", payload: { attemptId: "search-1", operation: "search", source: "freehire", query: "backend", location: "Remote", repeatCount: 0, requestedLimit: 2, remaining: { maxSearchCalls: 1, maxDetailCalls: 2, maxTotalResults: 4, maxRunDurationMs: 1000 } } });
  appendRunTrajectoryEvent(db, runId, { kind: "lifecycle", type: "search_completed", payload: { attemptId: "search-1", operation: "search", source: "freehire", query: "backend", location: "Remote", resultCount: 2, uniqueResultCount: 1, duplicateCount: 1, promisingResultCount: 0, counts: { discovered: 2, unique: 1 }, remaining: { maxSearchCalls: 1, maxDetailCalls: 2, maxTotalResults: 2, maxRunDurationMs: 900 } } });
  appendRunTrajectoryEvent(db, runId, { kind: "lifecycle", type: "search_state_inspected", payload: { counts: { discovered: 2, unique: 1, enriched: 0 }, coverage: { "role:backend": "medium" }, coverageSufficient: false, marginalUtility: { status: "low", score: 0, recentSearches: 1, recentUniqueJobs: 1, recentPromisingJobs: 0, repeatedZeroYieldSearches: 0, recommendation: "Vary query." }, remaining: { maxSearchCalls: 1, maxDetailCalls: 2, maxTotalResults: 2, maxRunDurationMs: 800 }, termination: null } });
  appendRunTrajectoryEvent(db, runId, { kind: "lifecycle", type: "search_finished", payload: { reason: "No more useful results.", reasonCategory: "marginal_utility_low", unresolvedGoals: ["compensation"], counts: { discovered: 2, unique: 1, enriched: 0 }, remaining: { maxSearchCalls: 1, maxDetailCalls: 2, maxTotalResults: 2, maxRunDurationMs: 700 } } });
  const app = await buildServer({ db, dataDir: process.cwd() });
  try {
    const response = await app.inject({ url: `/api/runs/${runId}/trajectory` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(Object.keys(body), ["runId", "status", "events", "observability"]);
    assert.equal(body.observability.attempts.length, 1);
    assert.equal(body.observability.attempts[0].query, "backend");
    assert.equal(body.observability.states[0].remaining.maxSearchCalls, 1);
    assert.equal(body.observability.termination.reason, "No more useful results.");
    assert.equal(body.events[0].type, "run_started");
    assert.equal((await app.inject({ url: "/api/runs/missing/trajectory" })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/runs?limit=1" })).json().runs.length, 1);

  } finally { await app.close(); db.close(); }
});

test("trajectory observability preserves legacy rows and exposes bounded search policy state", () => {
  const run = {
    workflow: "scrape",
    status: "succeeded",
    started_at: "2026-08-20T00:00:00.000Z",
    finished_at: "2026-08-20T00:00:05.000Z",
    error: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    estimated_cost: null,
  } satisfies Parameters<typeof deriveRunTrajectoryObservability>[0];
  const event = (sequence: number, type: string, payload: unknown, kind: TrajectoryEvent["kind"] = "lifecycle"): TrajectoryEvent => ({
    runId: "legacy-observability",
    sequence,
    kind,
    type,
    timestamp: `2026-08-20T00:00:0${sequence}.000Z`,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    payload,
  });
  const observability = deriveRunTrajectoryObservability(run, [
    event(4, "search_completed", { source: "freehire", resultCount: 2, uniqueResultCount: 1, duplicateCount: 1, promisingResultCount: 1, counts: { discovered: 2, unique: 1 }, remaining: { maxSearchCalls: 1, maxDetailCalls: 4, maxTotalResults: 8, maxRunDurationMs: 1000 } }),
    event(1, "search_started", { source: "freehire", attemptId: "search-1", query: "backend", location: "Remote", repeatCount: 0, remaining: { maxSearchCalls: 2, maxDetailCalls: 4, maxTotalResults: 10, maxRunDurationMs: 2000 } }),
    event(2, "search_state_inspected", { counts: { discovered: 2, unique: 1, enriched: 0 }, coverage: { "role:backend": "medium" }, coverageSufficient: false, marginalUtility: { status: "low", score: 0, recentSearches: 1, recentUniqueJobs: 1, recentPromisingJobs: 1, repeatedZeroYieldSearches: 0, recommendation: "Vary the query." }, remaining: { maxSearchCalls: 1, maxDetailCalls: 4, maxTotalResults: 8, maxRunDurationMs: 1000 }, termination: null }),
    event(3, "detail_provenance_rejected", { source: "freehire", resultIdLength: 120, error: "apiKey=sk-secret-value" }, "error"),
    event(5, "search_finished", { reason: "Coverage is sufficient.", reasonCategory: "coverage_sufficient", unresolvedGoals: [], counts: { discovered: 2, unique: 1, enriched: 0 }, remaining: { maxSearchCalls: 1, maxDetailCalls: 4, maxTotalResults: 8, maxRunDurationMs: 1000 } }),
  ]);
  assert.equal(observability.counts.unique, 1);
  assert.equal(observability.attempts[0]?.query, "backend");
  assert.equal(observability.attempts[0]?.status, "completed");
  assert.equal(observability.states[0]?.coverageSufficient, false);
  assert.equal(observability.termination?.category, "coverage_sufficient");
  assert.equal(observability.policyEvents[0]?.category, "provenance_rejection");
  assert.doesNotMatch(JSON.stringify(observability), /sk-secret-value/);
});
test("terminal search finish merges source stats and budget without inspect", () => {
  const run = {
    workflow: "scrape",
    status: "succeeded",
    started_at: "2026-08-20T00:00:00.000Z",
    finished_at: "2026-08-20T00:00:05.000Z",
    error: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    estimated_cost: null,
  } satisfies Parameters<typeof deriveRunTrajectoryObservability>[0];
  const event = (sequence: number, type: string, payload: unknown): TrajectoryEvent => ({
    runId: "terminal-observability",
    sequence,
    kind: "lifecycle",
    type,
    timestamp: `2026-08-20T00:00:0${sequence}.000Z`,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    payload,
  });
  const observability = deriveRunTrajectoryObservability(run, [
    event(1, "search_started", { attemptId: "search-1", operation: "search", source: "freehire", query: "backend", location: "Remote", remaining: { maxSearchCalls: 4, maxDetailCalls: 5, maxTotalResults: 7, maxRunDurationMs: 4000 } }),
    event(2, "search_completed", { attemptId: "search-1", operation: "search", source: "freehire", query: "backend", location: "Remote", resultCount: 3, uniqueResultCount: 3, duplicateCount: 0, promisingResultCount: 0 }),
    event(3, "detail_started", { attemptId: "detail-2", operation: "detail", source: "freehire", sourceId: "job-1", resultId: "job-1" }),
    event(4, "detail_completed", { attemptId: "detail-2", operation: "detail", source: "freehire", sourceId: "job-1", resultId: "job-1", enrichedCount: 1 }),
    event(5, "detail_started", { attemptId: "detail-3", operation: "detail", source: "freehire", sourceId: "job-2", resultId: "job-2" }),
    event(6, "detail_completed", { attemptId: "detail-3", operation: "detail", source: "freehire", sourceId: "job-2", resultId: "job-2", enrichedCount: 2 }),
    event(7, "search_finished", {
      reason: "Candidates are sufficient.",
      reasonCategory: "candidates_sufficient",
      counts: { discovered: 3, unique: 3, enriched: 2 },
      sourceStats: { freehire: { searchCalls: 1, detailCalls: 2, rawHits: 3, uniqueCount: 3, duplicateCount: 0, duplicateRate: 0, promisingJobs: 2, enrichedCount: 2, failures: 0 } },
      remaining: { maxSearchCalls: 4, maxDetailCalls: 3, maxTotalResults: 7, maxRunDurationMs: 3990 },
    }),
  ]);
  assert.equal(observability.attempts[0]?.promisingResultCount, 0);
  assert.equal(observability.sourceStats.freehire?.promisingCount, 2);
  assert.equal(observability.sourceStats.freehire?.enrichedCount, 2);
  assert.equal(observability.counts.enriched, 2);
  assert.equal(observability.states.length, 1);
  assert.equal(observability.states[0]?.remaining?.maxSearchCalls, 4);
  assert.equal(observability.states[0]?.remaining?.maxDetailCalls, 3);
});
test("task telemetry is ordered, retry-safe, and source-specific", () => {
  const db = openDatabase(":memory:");
  const runId = insertRun(db, "trajectory-tasks");
  const reporter = createTaskReporter(createTrajectoryRecorder(db), runId);
  try {
    reporter.start({ taskId: "scrape:search:freehire", label: "Search FreeHire", detail: "FreeHire" });
    reporter.complete("scrape:search:freehire", "1 result from FreeHire");
    reporter.start({ taskId: "scrape:validate", label: "Validate and score results" });
    reporter.fail("scrape:validate", "Validation failed; retrying.");
    reporter.start({ taskId: "scrape:validate", label: "Validate and score results" });
    reporter.complete("scrape:validate", "1 result validated");
    const events = listRunTrajectoryEvents(db, runId);
    assert.deepEqual(events.filter((event) => event.type.startsWith("task_")).map((event) => event.type), ["task_started", "task_completed", "task_started", "task_failed", "task_started", "task_completed"]);
    const rows = deriveRunTaskRows(events, "scrape", "running");
    assert.deepEqual(rows.map((row) => [row.label, row.status, row.detail, row.attempt]), [
      ["Search FreeHire", "completed", "1 result from FreeHire", 1],
      ["Validate and score results", "completed", "1 result validated", 2],
    ]);
    assert.deepEqual(deriveRunTaskRows([], "interview", "running").map((row) => row.status), ["active", "pending", "pending"]);
    assert.deepEqual(deriveRunTaskRows([], "profile_import", "running").map((row) => [row.taskId, row.label, row.status]), [
      ["profile_import:fallback:extract", "Read resume document", "active"],
      ["profile_import:fallback:map", "Map fields with Pi", "pending"],
      ["profile_import:fallback:merge", "Merge into profile bank", "pending"],
    ]);
    assert.deepEqual(deriveRunTaskRows([], "generate", "running").map((row) => [row.taskId, row.label]), [
      ["generate:fallback:prepare", "Prepare selected jobs"],
      ["generate:fallback:research", "Research company context"],
      ["generate:fallback:strategy", "Plan tailored content"],
      ["generate:fallback:writer", "Write tailored content"],
      ["generate:fallback:claims", "Validate claims"],
      ["generate:fallback:audit", "Audit factual claims"],
      ["generate:fallback:critic", "Critique document quality"],
      ["generate:fallback:revise", "Revise document"],
      ["generate:fallback:ats", "Review ATS coverage"],
      ["generate:fallback:ats-revise", "Revise ATS coverage"],
      ["generate:fallback:documents", "Compile and verify documents"],
      ["generate:fallback:finalize", "Finalize each job"],
    ]);
  } finally { db.close(); }
});

test("scrape manager records enabled-source tasks and cancelled active tasks never look successful", async () => {
  const db = openDatabase(":memory:");
  const job = (source: string) => ({ sourceId: `${source}-1`, source, url: `https://example.test/${source}-1`, company: `${source} company`, role: "Backend Engineer", location: "Remote", posting: "Build APIs.", score: 81, reason: "Strong fit", strengths: ["APIs"], gaps: [] });
  const context = { profile: "Backend profile", criteria: { ...defaultCriteria, maxJobsPerRun: 5 }, settings: { ...defaultSettings, enabledSources: ["freehire", "linkedin"] } };
  const executor = createMultiSourceScrapeExecutor(async (_context, source) => {
    const value = job(source);
    return { result: { jobs: [value] }, provenance: new Map([[value.sourceId, value.url]]) };
  });
  const manager = new RunManager(db, executor, async () => context, createTrajectoryRecorder(db));
  try {
    const runId = await manager.start();
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((manager.get(runId) as { status?: string } | undefined)?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const events = listRunTrajectoryEvents(db, runId);
    const rows = deriveRunTaskRows(events, "scrape", "succeeded");
    assert.equal(rows.find((row) => row.taskId === "scrape:search:freehire")?.label, "Search FreeHire");
    assert.equal(rows.find((row) => row.taskId === "scrape:search:linkedin")?.label, "Search LinkedIn");
    assert.ok(events.findIndex((event) => event.type === "task_started" && (event.payload as { taskId?: string }).taskId === "scrape:search:freehire") < events.findIndex((event) => event.type === "task_completed" && (event.payload as { taskId?: string }).taskId === "scrape:search:freehire"));

    const cancelledEvents = [
      { runId: "cancelled", sequence: 1, kind: "lifecycle" as const, type: "task_started", timestamp: "2026-08-20T00:00:00.000Z", startedAt: null, endedAt: null, durationMs: null, payload: { taskId: "scrape:search:linkedin", label: "Search LinkedIn", detail: "LinkedIn", status: "started" as const } },
    ];
    const cancelledRows = deriveRunTaskRows(cancelledEvents, "scrape", "cancelled");
    assert.equal(cancelledRows[0]?.status, "failed");
    assert.equal(cancelledRows[0]?.detail, "LinkedIn");
    assert.notEqual(cancelledRows[0]?.detail, "Run succeeded.");
    assert.equal(deriveRunTaskRows([], "follow_up", "cancelled")[0]?.detail, "Run cancelled.");
  } finally { db.close(); }
});

class TrajectoryFakeSession implements PiSessionLike {
  private listener: ((event: unknown) => void) | null = null;
  disposed = false;
  promptText = "";
  readonly systemPrompt = "You are a trajectory test assistant.";
  subscribe(listener: (event: unknown) => void) { this.listener = listener; return () => { this.listener = null; }; }
  getActiveToolNames() { return ["lookupJob"]; }
  getAllTools() { return [{ name: "lookupJob", description: "Looks up one job.", parameters: { type: "object" } }]; }
  async prompt(text: string) {
    this.promptText = text;
    const emit = (event: unknown) => this.listener?.(event);
    const message = { role: "assistant", timestamp: Date.now(), content: [] };
    emit({ type: "agent_start" });
    emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "Answer" } });
    emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", delta: "Plan" } });
    emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "lookupJob", args: { id: "job-1" } });
    emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "lookupJob", args: { id: "job-1" }, partialResult: { stage: "loading" } });
    emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "lookupJob", result: { stage: "ready" }, isError: false });
    emit({ type: "message_end", message: { ...message, content: [{ type: "text", text: "Answer" }, { type: "thinking", thinking: "Plan" }] } });
    emit({ type: "agent_end", messages: [] });
    emit({ type: "agent_settled" });
  }
  async abort() {}
  dispose() { this.disposed = true; }
}

test("runBoundedPi persists prompts, aggregated assistant/thinking, tools, and terminal events", async () => {
  const previousMode = process.env.TELEMETRY_MODE;
  process.env.TELEMETRY_MODE = "redacted";
  const db = openDatabase(":memory:");
  const runId = insertRun(db, "trajectory-pi");
  const recorder = createTrajectoryRecorder(db);
  const session = new TrajectoryFakeSession();
  try {
    await runBoundedPi({
      runId,
      trajectory: recorder,
      prompt: "Exact user prompt",
      guidance: "Use only supplied facts.",
      settings: { provider: "fixture", model: "model" },
      model: "fixture-model",
      timeoutMs: 1_000,
      createSession: async () => session,
    });
    assert.equal(session.promptText, "Exact user prompt");
    assert.equal(session.disposed, true);
    const events = listRunTrajectoryEvents(db, runId);
    const types = events.map((event) => event.type);
    for (const expected of ["system_prompt", "tool_catalog", "run_context", "user_prompt", "agent_start", "turn_start", "assistant_message", "assistant_thinking", "tool_execution_start", "tool_execution_update", "tool_execution_end", "run_completed", "agent_settled", "session_disposed"]) assert.ok(types.includes(expected), expected);
    assert.equal((events.find((event) => event.type === "user_prompt")?.payload as { text: string }).text, "Exact user prompt");
    assert.equal((events.find((event) => event.type === "assistant_message")?.payload as { text: string }).text, "Answer");
    assert.equal((events.find((event) => event.type === "assistant_thinking")?.payload as { text: string }).text, "Plan");
    assert.equal((events.find((event) => event.type === "tool_execution_end")?.payload as { isError: boolean }).isError, false);
    assert.match(String((events.find((event) => event.type === "run_context")?.payload as { promptHash?: string }).promptHash), /^[0-9a-f]{64}$/);
  } finally {
    if (previousMode === undefined) delete process.env.TELEMETRY_MODE;
    else process.env.TELEMETRY_MODE = previousMode;
    db.close();
  }
});
