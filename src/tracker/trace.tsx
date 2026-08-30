import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Run, RunStatus, RunTaskRow, RunWorkflow, TrajectoryEvent } from "../shared.js";
import { deriveRunTaskRows } from "../shared.js";
import { getRun, getRunTrajectory, getRuns } from "../api.js";
import { trackerHref } from "./hash.js";
import { shouldRefreshActiveRun } from "./visibility.js";

const RUN_SYNC_TYPE = "tracker-active-run" as const;
const RUN_SYNC_CHANNEL = "jobdesk-tracker-runs";
const MAX_PAYLOAD_CHARS = 8_000;
const secretKey = /(?:api[_-]?key|apikey|token|secret|password|authorization|credential|cookie|private[_-]?key|stack|prompt)/i;
const secretString = /((?:api[_-]?key|apikey|token|secret|password|authorization|credential|cookie|private[_-]?key)\s*[:=]\s*["']?)[^"'\s,}]+|((?:bearer\s+))[^\s,}]+/gi;

export type RunSyncMessage = { type: typeof RUN_SYNC_TYPE; runId: string | null };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function scrubString(value: string) {
  return value
    .replace(/(https?:\/\/)([^/\s:@]+)(?::[^/\s@]*)?@/gi, "$1[redacted]@")
    .replace(secretString, (_match, prefix: string | undefined, bearer: string | undefined) => `${prefix ?? bearer ?? ""}[redacted]`)
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}

function scrub(value: unknown, seen: WeakSet<object>, key = "", depth = 0): unknown {
  if (key && secretKey.test(key)) return "[redacted]";
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (depth > 6) return "[nested payload omitted]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular payload]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, seen, "", depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([name, item]) => [name, scrub(item, seen, name, depth + 1)]));
}

export function safePayloadText(value: unknown) {
  const clean = scrub(value, new WeakSet<object>());
  let output: string;
  if (typeof clean === "string") output = clean;
  else {
    try { output = JSON.stringify(clean, null, 2) ?? "null"; }
    catch { output = "[Payload could not be displayed]"; }
  }
  return output.length > MAX_PAYLOAD_CHARS ? `${output.slice(0, MAX_PAYLOAD_CHARS)}\n[Payload truncated]` : output;
}

function summaryText(value: string) {
  return scrubString(value).replace(/\s+/g, " ").trim().slice(0, 150);
}

export function eventSummary(event: TrajectoryEvent) {
  const payload = record(event.payload);
  if (typeof payload?.text === "string" && summaryText(payload.text)) return summaryText(payload.text);
  if (typeof payload?.toolName === "string") return summaryText(payload.toolName);
  if (typeof payload?.error === "string") return summaryText(payload.error);
  if (typeof payload?.status === "string") return summaryText(payload.status);
  if (event.type.startsWith("verifier_")) return summaryText(event.type.replaceAll("_", " "));
  return event.type.replaceAll("_", " ");
}

export function formatTraceDuration(milliseconds: number | null) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function runElapsedMs(run: Pick<Run, "started_at" | "finished_at">, now = Date.now()) {
  const start = Date.parse(run.started_at);
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

export function traceTaskSummary(events: readonly TrajectoryEvent[], workflow: RunWorkflow, status: RunStatus) {
  const rows = deriveRunTaskRows(events, workflow, status);
  return {
    completed: rows.filter((row) => row.status === "completed").length,
    active: rows.filter((row) => row.status === "active").length,
    failed: rows.filter((row) => row.status === "failed").length,
    total: rows.length,
  };
}

export type TraceOperations = {
  attempt: number | string;
  retryReason: string | null;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  verifierStatus: string;
  needsReview: boolean;
  sessionReuse: string;
  queuePosition: string | null;
  cancellationReason: string | null;
};

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageFromPayload(payload: Record<string, unknown> | null) {
  const usage = record(payload?.usage);
  if (!usage) return null;
  const inputTokens = finiteNumber(usage.inputTokens) ?? finiteNumber(usage.input);
  const outputTokens = finiteNumber(usage.outputTokens) ?? finiteNumber(usage.output);
  const totalTokens = finiteNumber(usage.totalTokens) ?? finiteNumber(usage.total) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cost = record(usage.cost);
  const estimatedCost = finiteNumber(usage.estimatedCost) ?? finiteNumber(cost?.total);
  if (inputTokens === null && outputTokens === null && totalTokens === null && estimatedCost === null) return null;
  return { inputTokens, outputTokens, totalTokens, estimatedCost };
}

function aggregateEventUsage(events: readonly TrajectoryEvent[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasTotal = false;
  let hasCost = false;
  const add = (usage: NonNullable<ReturnType<typeof usageFromPayload>>) => {
    if (usage.inputTokens !== null) { inputTokens += usage.inputTokens; hasInput = true; }
    if (usage.outputTokens !== null) { outputTokens += usage.outputTokens; hasOutput = true; }
    if (usage.totalTokens !== null) { totalTokens += usage.totalTokens; hasTotal = true; }
    if (usage.estimatedCost !== null) { estimatedCost += usage.estimatedCost; hasCost = true; }
  };
  for (const event of events) {
    if (event.type !== "assistant_message" && event.type !== "assistant_thinking") continue;
    const usage = usageFromPayload(record(event.payload));
    if (usage) add(usage);
  }
  return {
    inputTokens: hasInput ? inputTokens : null,
    outputTokens: hasOutput ? outputTokens : null,
    totalTokens: hasTotal ? totalTokens : null,
    estimatedCost: hasCost ? estimatedCost : null,
  };
}

function terminalErrorCode(events: readonly TrajectoryEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!["run_failed", "run_timed_out", "run_cancelled"].includes(event.type)) continue;
    const code = record(event.payload)?.errorCode;
    if (typeof code === "string" && code) return code;
  }
  return null;
}

function inferErrorCode(run: Run) {
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "timed_out") return "timeout";
  const error = run.error ?? "";
  if (/timed out/i.test(error)) return "timeout";
  if (/cancel/i.test(error)) return "cancelled";
  if (run.status === "failed") return "provider";
  return null;
}

function deriveVerifierStatus(run: Run, verifierEvents: readonly TrajectoryEvent[]) {
  if (verifierEvents.some((event) => event.type === "verifier_needs_review")) return "needs_review";
  if (verifierEvents.some((event) => event.type === "verifier_completed")) return "passed";
  if (verifierEvents.some((event) => event.type === "verifier_failed")) return "warning";
  if (verifierEvents.some((event) => event.type === "verifier_skipped")) return "skipped";
  if ((run.status === "failed" || run.status === "cancelled" || run.status === "timed_out") && (run.workflow === "scrape" || run.workflow === "generate")) return "skipped";
  return "—";
}

export function formatEstimatedCost(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function deriveTraceOperations(run: Run, events: readonly TrajectoryEvent[]): TraceOperations {
  const invalid = events.filter((event) => event.type === "structured_output_invalid");
  const lastRetry = invalid.at(-1);
  const verifierEvents = events.filter((event) => event.type.startsWith("verifier_"));
  const needsReview = verifierEvents.some((event) => event.type === "verifier_needs_review");
  const sessionStarts = events.filter((event) => event.type === "session_start").length;
  const eventUsage = aggregateEventUsage(events);
  return {
    attempt: run.attempt_count ?? (invalid.length > 0 ? invalid.length + 1 : 1),
    retryReason: typeof record(lastRetry?.payload)?.error === "string" ? String(record(lastRetry?.payload)?.error) : null,
    errorCode: run.error_code ?? terminalErrorCode(events) ?? inferErrorCode(run),
    inputTokens: run.input_tokens ?? eventUsage.inputTokens,
    outputTokens: run.output_tokens ?? eventUsage.outputTokens,
    totalTokens: run.total_tokens ?? eventUsage.totalTokens,
    estimatedCost: run.estimated_cost ?? eventUsage.estimatedCost,
    verifierStatus: deriveVerifierStatus(run, verifierEvents),
    needsReview,
    sessionReuse: sessionStarts > 1 ? "rebuilt" : sessionStarts === 1 ? "reused" : "—",
    queuePosition: run.status === "queued" ? "queued" : null,
    cancellationReason: run.status === "cancelled" ? (run.error ?? "cancelled") : null,
  };
}

export function runSyncMessage(runId: string | null): RunSyncMessage {
  return { type: RUN_SYNC_TYPE, runId };
}

export function isRunSyncMessage(value: unknown): value is RunSyncMessage {
  const payload = record(value);
  if (!payload || Object.keys(payload).some((key) => key !== "type" && key !== "runId")) return false;
  return payload.type === RUN_SYNC_TYPE && (payload.runId === null || typeof payload.runId === "string");
}

export function createRunSyncChannel(onMessage: (message: RunSyncMessage) => void) {
  if (typeof BroadcastChannel !== "function") return { notify: (_runId: string | null) => undefined, close: () => undefined };
  try {
    const channel = new BroadcastChannel(RUN_SYNC_CHANNEL);
    const listener = (event: MessageEvent) => { if (isRunSyncMessage(event.data)) onMessage(event.data); };
    channel.addEventListener("message", listener);
    return {
      notify(runId: string | null) { try { channel.postMessage(runSyncMessage(runId)); } catch { /* channel is best effort; API remains authoritative */ } },
      close() { channel.removeEventListener("message", listener); channel.close(); },
    };
  } catch {
    return { notify: (_runId: string | null) => undefined, close: () => undefined };
  }
}

function workflowLabel(workflow: RunWorkflow) {
  return workflow === "follow_up" ? "FOLLOW-UP" : workflow.toUpperCase();
}

function eventTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function safeError(value: string | null | undefined) {
  return value ? summaryText(value) : "—";
}

function TraceLink({ href, navigate, children, className = "" }: { href: string; navigate: (href: string) => void; children: ReactNode; className?: string }) {
  return <a className={className} href={href} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(href); }}>{children}</a>;
}

export function TraceView({ runId, activeRun, navigate, now }: { runId?: string; activeRun: Run | null; navigate: (href: string) => void; now: number }) {
  return <section className="panel trace-panel">{runId ? <TraceDetail id={runId} navigate={navigate} now={now} /> : <TraceHistory activeRun={activeRun} navigate={navigate} now={now} />}</section>;
}

function TraceHistory({ activeRun, navigate, now }: { activeRun: Run | null; navigate: (href: string) => void; now: number }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loaded = useRef(false);
  const refresh = useCallback(async (initial = false) => {
    if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) return;
    if (initial) setLoading(true);
    try { setRuns((await getRuns()).runs); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Run history unavailable."); }
    finally {
      if (initial) {
        loaded.current = true;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const start = (initial = false) => {
      stop();
      if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) return;
      void refresh(initial);
      if (activeRun?.status === "running") timer = window.setInterval(() => void refresh(), 1_000);
    };
    const onVisibility = () => start(!loaded.current);
    const onFocus = () => start(!loaded.current);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    start(true);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      stop();
    };
  }, [activeRun?.id, activeRun?.status, refresh]);

  return <div className="trace-content">
    <header className="trace-heading">
      <div><div className="trace-eyebrow">TRACE 06 · RUN HISTORY</div><h1>Run history</h1><p>Persisted workflow runs, task timing, and safe trajectory details.</p></div>
      <button type="button" className="trace-button" onClick={() => void refresh()}>Refresh</button>
    </header>
    {error && <div className="trace-notice" role="status">Refresh failed. {safeError(error)}</div>}
    {loading && !runs.length ? <p className="empty">Loading run history…</p> : runs.length ? <div className="trace-history" aria-label="Run history">{runs.map((run) => <RunHistoryRow key={run.id} run={run} active={run.id === activeRun?.id} navigate={navigate} now={now} />)}</div> : <div className="trace-empty"><strong>No runs yet.</strong><p>Play a workflow to create its persisted trace.</p></div>}
  </div>;
}

function RunHistoryRow({ run, active, navigate, now }: { run: Run; active: boolean; navigate: (href: string) => void; now: number }) {
  return <TraceLink href={trackerHref("trace", run.id)} navigate={navigate} className={`trace-history-row run-${run.status} ${active ? "is-active" : ""}`}>
    <span className="trace-history-main"><span className="trace-label">{workflowLabel(run.workflow)}</span><strong>{run.status === "running" ? "IN PROGRESS" : run.status.toUpperCase()}</strong><small>{run.id}</small></span>
    <span><em>PROVIDER / MODEL</em><strong>{run.provider} / {run.model || "default"}</strong></span>
    <span><em>STARTED</em><strong>{dateTime(run.started_at)}</strong></span>
    <span><em>ELAPSED</em><strong>{formatTraceDuration(runElapsedMs(run, now))}</strong></span>
    <span className="trace-arrow" aria-hidden="true">→</span>
  </TraceLink>;
}

function TraceDetail({ id, navigate, now }: { id: string; navigate: (href: string) => void; now: number }) {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<TrajectoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadedRunId = useRef<string | null>(null);
  const refresh = useCallback(async (initial = false) => {
    if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) return;
    if (initial) setLoading(true);
    try {
      const [nextRun, trajectory] = await Promise.all([getRun(id), getRunTrajectory(id)]);
      setRun(nextRun); setEvents(trajectory.events); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Trajectory unavailable."); }
    finally {
      if (initial) {
        loadedRunId.current = id;
        setLoading(false);
      }
    }
  }, [id]);

  useEffect(() => { void refresh(true); }, [refresh]);
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus()) || !run || run.status !== "running") return;
      timer = window.setInterval(() => void refresh(), 800);
    };
    const onRefresh = () => {
      if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) {
        stop();
        return;
      }
      void refresh(loadedRunId.current !== id);
      start();
    };
    document.addEventListener("visibilitychange", onRefresh);
    window.addEventListener("focus", onRefresh);
    start();
    return () => {
      document.removeEventListener("visibilitychange", onRefresh);
      window.removeEventListener("focus", onRefresh);
      stop();
    };
  }, [id, refresh, run?.status]);

  if (loading) return <div className="trace-content"><p className="empty">Loading trajectory…</p></div>;
  if (error && !run) return <div className="trace-content"><TraceLink href={trackerHref("trace")} navigate={navigate} className="trace-back">← TRACE</TraceLink><p className="empty">{safeError(error)}</p></div>;
  if (!run) return <div className="trace-content"><TraceLink href={trackerHref("trace")} navigate={navigate} className="trace-back">← TRACE</TraceLink><div className="trace-empty"><strong>Run not found.</strong><p>Return to TRACE history and choose another run.</p></div></div>;

  const taskRows = deriveRunTaskRows(events, run.workflow, run.status);
  const taskSummary = traceTaskSummary(events, run.workflow, run.status);
  const operations = deriveTraceOperations(run, events);
  const start = Date.parse(run.started_at);
  const end = Date.parse(run.finished_at ?? events.at(-1)?.endedAt ?? events.at(-1)?.timestamp ?? new Date(now).toISOString());
  const range = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;

  return <div className="trace-content">
    <div className="trace-back-row"><TraceLink href={trackerHref("trace")} navigate={navigate} className="trace-back">← ALL RUNS</TraceLink><span className="trace-eyebrow">{workflowLabel(run.workflow)} · {run.id}</span></div>
    <header className="trace-heading">
      <div><div className="trace-eyebrow">TRAJECTORY INSPECTOR</div><h1>{run.status === "running" ? "Live run" : "Completed run"}</h1><p>{run.status === "running" ? <span aria-live="polite">API trace polling is live.</span> : "Persisted event ledger for this workflow."}</p></div>
      <div className="trace-actions"><button type="button" className="trace-button" onClick={() => void refresh()}>Refresh</button><TraceLink href={trackerHref("trace")} navigate={navigate} className="trace-button">History</TraceLink></div>
    </header>
    {error && <div className="trace-notice" role="status">Refresh failed. Showing the last captured trace.</div>}
    <section className="trace-meta" aria-label="Run metadata">
      <TraceMeta label="STATUS"><span className={`trace-status status-${run.status}`}>{run.status}</span></TraceMeta>
      <TraceMeta label="PROVIDER / MODEL">{run.provider} / {run.model || "default"}</TraceMeta>
      <TraceMeta label="STARTED">{dateTime(run.started_at)}</TraceMeta>
      <TraceMeta label="FINISHED">{dateTime(run.finished_at)}</TraceMeta>
      <TraceMeta label="ELAPSED">{formatTraceDuration(runElapsedMs(run, now))}</TraceMeta>
      <TraceMeta label="ERROR">{safeError(run.error)}</TraceMeta>
    </section>
    <section className="trace-meta" aria-label="Run operations">
      <TraceMeta label="ATTEMPT">{operations.attempt}</TraceMeta>
      <TraceMeta label="ERROR CODE">{operations.errorCode ?? "—"}</TraceMeta>
      <TraceMeta label="TOKENS">{operations.totalTokens ?? operations.inputTokens ?? "—"}</TraceMeta>
      <TraceMeta label="EST. COST">{formatEstimatedCost(operations.estimatedCost)}</TraceMeta>
      <TraceMeta label="VERIFIER">{operations.verifierStatus}</TraceMeta>
      <TraceMeta label="SESSION">{operations.sessionReuse}</TraceMeta>
      {operations.needsReview && <TraceMeta label="REVIEW">needs review</TraceMeta>}
      {operations.retryReason && <TraceMeta label="RETRY">{operations.retryReason}</TraceMeta>}
      {operations.queuePosition && <TraceMeta label="QUEUE">{operations.queuePosition}</TraceMeta>}
      {operations.cancellationReason && <TraceMeta label="CANCEL">{operations.cancellationReason}</TraceMeta>}
    </section>
    <section className="trace-section" aria-label="Task overview">
      <div className="trace-section-head"><h2>Task overview</h2><span>{taskSummary.completed}/{taskSummary.total} complete</span></div>
      <div className="trace-progress" role="progressbar" aria-label={`${taskSummary.completed} of ${taskSummary.total} tasks complete`} aria-valuemin={0} aria-valuemax={Math.max(1, taskSummary.total)} aria-valuenow={taskSummary.completed}><i style={{ width: `${taskSummary.total ? (taskSummary.completed / taskSummary.total) * 100 : 0}%` }} /></div>
      <div className="trace-tasks">{taskRows.map((row) => <TaskRow key={row.taskId} row={row} />)}</div>
    </section>
    <section className="trace-section" aria-label="Timing overview">
      <div className="trace-section-head"><h2>Timing</h2><span>{formatTraceDuration(range)} · {events.length} events</span></div>
      <div className="trace-rail" role="img" aria-label={`${events.length} events across ${formatTraceDuration(range)}`}><span />{events.map((event, index) => { const timestamp = Date.parse(event.timestamp); const left = range > 0 && Number.isFinite(timestamp) ? Math.min(100, Math.max(0, ((timestamp - start) / range) * 100)) : (index / Math.max(1, events.length - 1)) * 100; return <i key={event.sequence} className={`event-${event.kind}`} style={{ left: `${left}%` }} title={`${event.type} · ${eventTime(event.timestamp)}`} />; })}</div>
      <div className="trace-rail-labels"><span>START</span><span>{dateTime(run.started_at)}</span><span>{run.status === "running" ? "LIVE" : "FINISH"}</span></div>
    </section>
    {run.summary !== null && <details className="trace-payload"><summary>Run result summary</summary><pre>{safePayloadText(run.summary)}</pre></details>}
    <section className="trace-section" aria-label="Trajectory event list">
      <div className="trace-section-head"><h2>Event ledger</h2><span>oldest first</span></div>
      {events.length ? <div className="trace-events">{events.map((event) => <TraceEvent key={`${event.sequence}-${event.type}`} event={event} />)}</div> : <p className="empty">No visible trajectory events were persisted.</p>}
    </section>
  </div>;
}

function TraceMeta({ label, children }: { label: string; children: ReactNode }) {
  return <div className="trace-meta-item"><em>{label}</em><strong>{children}</strong></div>;
}

function TaskRow({ row }: { row: RunTaskRow }) {
  return <div className={`trace-task task-${row.status}`}><i aria-hidden="true" /><span><strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}</span><b>{row.status === "active" ? "IN PROGRESS" : row.status.toUpperCase()}</b></div>;
}

function TraceEvent({ event }: { event: TrajectoryEvent }) {
  return <details className={`trace-event event-${event.kind}`}>
    <summary><span className="trace-event-main"><em>{event.kind.replaceAll("_", " ")}</em><strong>{event.type.replaceAll("_", " ")}</strong><small>{eventSummary(event)}</small></span><span className="trace-event-time"><strong>{eventTime(event.timestamp)}</strong><small>{formatTraceDuration(event.durationMs)}</small></span></summary>
    <div className="trace-event-body"><div className="trace-event-facts"><span>SEQ <b>{event.sequence}</b></span><span>CAPTURED <b>{dateTime(event.timestamp)}</b></span>{event.startedAt && <span>STARTED <b>{dateTime(event.startedAt)}</b></span>}{event.endedAt && <span>ENDED <b>{dateTime(event.endedAt)}</b></span>}</div><pre>{safePayloadText(event.payload)}</pre></div>
  </details>;
}
