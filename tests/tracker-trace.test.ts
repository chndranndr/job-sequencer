import assert from "node:assert/strict";
import test from "node:test";
import type { Run, TrajectoryEvent } from "../src/shared.js";
import { parseTrackerHash, trackerHref } from "../src/tracker/hash.js";
import {
  deriveTraceOperations,
  eventSummary,
  formatEstimatedCost,
  formatTraceDuration,
  isRunSyncMessage,
  runSyncMessage,
  safePayloadText,
  traceTaskSummary,
} from "../src/tracker/trace.js";

function event(sequence: number, type: string, payload: unknown, kind: TrajectoryEvent["kind"] = "lifecycle"): TrajectoryEvent {
  return {
    runId: "trace-test",
    sequence,
    kind,
    type,
    timestamp: "2026-08-24T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    payload,
  };
}

test("TRACE routes parse and encode run IDs without changing existing route shape", () => {
  assert.deepEqual(parseTrackerHash("#/trace"), { view: "trace", jobId: undefined, orderFocus: undefined, mixFocus: undefined, runId: undefined });
  assert.deepEqual(parseTrackerHash("#/trace/run%2Fone"), { view: "trace", jobId: undefined, orderFocus: undefined, mixFocus: undefined, runId: "run/one" });
  assert.deepEqual(parseTrackerHash("#/pattern"), { view: "pattern", jobId: undefined, orderFocus: undefined, mixFocus: undefined });
  assert.equal(trackerHref("trace", "run/one"), "#/trace/run%2Fone");
});

test("TRACE event summaries prefer useful safe fields and task summaries are deterministic", () => {
  assert.equal(eventSummary(event(1, "tool_execution_start", { toolName: "lookupJob" }, "tool_call")), "lookupJob");
  assert.equal(eventSummary(event(2, "assistant_message", { text: "  hello   tracker  " }, "assistant")), "hello tracker");
  assert.equal(eventSummary(event(3, "run_failed", { error: "Provider unavailable" }, "error")), "Provider unavailable");

  const events = [
    event(1, "task_started", { taskId: "prepare", label: "Prepare", status: "started" }),
    event(2, "task_completed", { taskId: "prepare", label: "Prepare", status: "completed" }),
    event(3, "task_started", { taskId: "search", label: "Search", status: "started" }),
  ];
  assert.deepEqual(traceTaskSummary(events, "scrape", "running"), { completed: 1, active: 1, failed: 0, total: 2 });
});

test("TRACE payload inspection redacts secret-shaped values and sync messages carry only a safe hint", () => {
  const payload = safePayloadText({ apiKey: "sk-live-secret", nested: { password: "pw-secret" }, text: "visible context" });
  assert.doesNotMatch(payload, /sk-live-secret|pw-secret/);
  assert.match(payload, /\[redacted\]/);
  assert.match(payload, /visible context/);

  const message = runSyncMessage("run-1");
  assert.deepEqual(message, { type: "tracker-active-run", runId: "run-1" });
  assert.equal(isRunSyncMessage(message), true);
  assert.equal(isRunSyncMessage({ type: "tracker-active-run", runId: "run-1", payload: "secret" }), false);
  assert.equal(isRunSyncMessage({ type: "tracker-active-run", runId: 42 }), false);
  assert.equal(isRunSyncMessage({ type: "other", runId: "run-1" }), false);
});

test("TRACE duration formatting handles terminal and live runs", () => {
  const run = { started_at: "2026-08-24T00:00:00.000Z", finished_at: "2026-08-24T00:00:02.500Z" } as Run;
  assert.equal(formatTraceDuration(2_500), "2.5s");
  assert.equal(formatTraceDuration(65_000), "1m 5s");
  assert.equal(formatTraceDuration(null), "—");
  assert.equal(formatTraceDuration(Date.parse(run.finished_at!) - Date.parse(run.started_at)), "2.5s");
});

test("TRACE operations derive retry, usage, verifier, and review markers", () => {
  const run = {
    id: "run-ops",
    workflow: "scrape",
    status: "succeeded",
    provider: "fixture",
    model: "model",
    summary: null,
    error_code: null,
    attempt_count: 2,
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    estimated_cost: 0.4,
    started_at: "2026-08-24T00:00:00.000Z",
    finished_at: "2026-08-24T00:00:01.000Z",
  } as Run;
  const events = [
    event(1, "structured_output_invalid", { error: "schema mismatch" }, "error"),
    event(2, "verifier_needs_review", { verifier: "rank", status: "needs_review" }),
    event(3, "session_start", null),
  ];
  const ops = deriveTraceOperations(run, events);
  assert.equal(ops.attempt, 2);
  assert.equal(ops.retryReason, "schema mismatch");
  assert.equal(ops.totalTokens, 30);
  assert.equal(ops.verifierStatus, "needs_review");
  assert.equal(ops.needsReview, true);
  assert.equal(ops.sessionReuse, "reused");
});

test("TRACE operations fall back to trajectory and inferred values when run telemetry is missing", () => {
  const run = {
    id: "run-fallback",
    workflow: "scrape",
    status: "failed",
    provider: "openai-codex",
    model: "gpt-3.5-turbo",
    summary: null,
    error: "Scrape failed. Check provider settings and try again.",
    started_at: "2026-08-24T00:00:00.000Z",
    finished_at: "2026-08-24T00:00:03.500Z",
  } as Run;
  const events = [
    event(1, "session_start", null),
    event(2, "assistant_message", { usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, estimatedCost: 0.004 } }, "assistant"),
    event(3, "run_failed", { status: "failed", error: run.error, errorCode: "provider" }, "error"),
  ];
  const ops = deriveTraceOperations(run, events);
  assert.equal(ops.errorCode, "provider");
  assert.equal(ops.totalTokens, 20);
  assert.equal(ops.estimatedCost, 0.004);
  assert.equal(ops.verifierStatus, "skipped");
  assert.equal(formatEstimatedCost(ops.estimatedCost), "$0.0040");
});

test("TRACE operations infer provider failures when only the safe run error is persisted", () => {
  const run = {
    id: "run-infer",
    workflow: "scrape",
    status: "failed",
    provider: "openai-codex",
    model: "gpt-3.5-turbo",
    summary: null,
    error: "Scrape failed. Check provider settings and try again.",
    started_at: "2026-08-24T00:00:00.000Z",
    finished_at: "2026-08-24T00:00:03.500Z",
  } as Run;
  const ops = deriveTraceOperations(run, [event(1, "session_start", null)]);
  assert.equal(ops.errorCode, "provider");
  assert.equal(ops.verifierStatus, "skipped");
});
