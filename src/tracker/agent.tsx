import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { JobStage, Run, RunTaskRow, TrajectoryEvent } from "../shared.js";
import { deriveRunTaskRows } from "../shared.js";
import { SurferLoader } from "../surfer-loader.js";
import { trackerHref } from "./hash.js";
import { isNarrowLayout, NARROW_LAYOUT_MQ } from "./narrow.js";

function payloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function toolNames(events: readonly TrajectoryEvent[]) {
  const names: string[] = [];
  for (const event of events) {
    if (event.kind !== "tool_call" && event.kind !== "tool_result") continue;
    const payload = payloadRecord(event.payload);
    const name = typeof payload?.toolName === "string" ? payload.toolName : event.type;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 8);
}

export function thinkingText(events: readonly TrajectoryEvent[]) {
  const parts = events.filter((event) => event.kind === "thinking" || event.kind === "assistant").map((event) => {
    const payload = payloadRecord(event.payload);
    if (typeof payload?.text === "string") return payload.text;
    if (typeof event.payload === "string") return event.payload;
    return "";
  }).filter(Boolean);
  return parts.at(-1) ?? "";
}

export function searchText(events: readonly TrajectoryEvent[]) {
  const hit = [...events].reverse().find((event) => event.kind === "tool_call" || event.kind === "tool_result");
  if (!hit) return "";
  const payload = payloadRecord(hit.payload);
  if (typeof payload?.text === "string") return payload.text;
  try { return JSON.stringify(payload ?? hit.payload, null, 2); } catch { return hit.type; }
}

export function taskClass(status: RunTaskRow["status"]) {
  return status === "completed" ? "done" : status === "active" ? "run" : status === "failed" ? "fail" : "";
}

export function PixelLoader({ label, elapsed }: { label: string; elapsed: string }) {
  return <div className="loader">
    <div className="px-grid drive" aria-hidden="true">{Array.from({ length: 64 }, (_, i) => <b key={i} />)}</div>
    <div className="copy"><strong>{label}</strong><small>Drive</small><span className="elapsed">{elapsed}</span></div>
  </div>;
}

function formatElapsed(startedAt: string, finishedAt: string | null | undefined, now: number) {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt ?? "") || now;
  if (!Number.isFinite(start) || end < start) return "0.0s";
  return `${((end - start) / 1000).toFixed(1)}s`;
}

const MIN_AGENT_WIDTH = 260;
const MAX_AGENT_WIDTH = 420;
const COLLAPSED_AGENT_WIDTH = 48;

function clampAgentWidth(value: number) {
  return Math.max(MIN_AGENT_WIDTH, Math.min(MAX_AGENT_WIDTH, value));
}

export function ActiveRunStrip({ run, events, now, navigate, onCancel }: { run: Run | null; events: TrajectoryEvent[]; now: number; navigate: (href: string) => void; onCancel: () => void }) {
  if (!run) return null;
  const rows = deriveRunTaskRows(events, run.workflow, run.status);
  const completed = rows.filter((row) => row.status === "completed").length;
  const running = run.status === "running";
  return <section className="active-run-strip" aria-label="Active run synchronization">
    <div className="active-run-head"><span className="active-run-led" aria-hidden="true" /><span><strong>{running ? "ACTIVE RUN" : "LAST RUN"}</strong><small>{run.workflow} · {run.status} · {formatElapsed(run.started_at, run.finished_at, now)}</small></span><span className="active-run-tasks" aria-live="polite">{completed}/{rows.length} tasks</span><button type="button" className="active-run-stop" disabled={!running} onClick={onCancel}>STOP</button><button type="button" className="active-run-trace" onClick={() => navigate(trackerHref("trace", run.id))}>TRACE</button></div>
    <div className="active-run-progress" role="progressbar" aria-label={`${completed} of ${rows.length} run tasks complete`} aria-valuemin={0} aria-valuemax={Math.max(1, rows.length)} aria-valuenow={completed}><i style={{ width: `${rows.length ? (completed / rows.length) * 100 : 0}%` }} /></div>
    <div className="active-run-task-list">{rows.map((row) => <span className={`active-run-task task-${row.status}`} key={row.taskId}><i aria-hidden="true" />{row.label}{row.detail ? ` · ${row.detail}` : ""}</span>)}</div>
  </section>;
}

export function AgentPane({
  run, events, pendingScrape, scrapeIssues, onConfirmScrape, onCancelPending, navigate, onFilter, now,
}: {
  run: Run | null;
  events: TrajectoryEvent[];
  pendingScrape: boolean;
  scrapeIssues: string[];
  onConfirmScrape: () => void;
  onCancelPending: () => void;
  navigate: (href: string) => void;
  onFilter: (stage: JobStage | "all") => void;
  now: number;
}) {
  const [tab, setTab] = useState<"Steps" | "Reasoning" | "Search">("Steps");
  const [agentWidth, setAgentWidth] = useState(280);
  const [agentCollapsed, setAgentCollapsed] = useState(isNarrowLayout);
  const [resizingAgent, setResizingAgent] = useState(false);
  const agentResizeStart = useRef<{ clientX: number; width: number } | null>(null);
  useEffect(() => {
    const media = window.matchMedia(NARROW_LAYOUT_MQ);
    const collapseWhenNarrow = () => { if (media.matches) setAgentCollapsed(true); };
    collapseWhenNarrow();
    media.addEventListener("change", collapseWhenNarrow);
    return () => media.removeEventListener("change", collapseWhenNarrow);
  }, []);
  const running = run?.status === "running";
  const rows = run ? deriveRunTaskRows(events, run.workflow, run.status) : [];
  const tools = toolNames(events);
  const thought = thinkingText(events);
  const search = searchText(events);
  const showReasoning = Boolean(thought) || running;
  const elapsed = run ? formatElapsed(run.started_at, run.finished_at, now) : "0.0s";
  const agentTabs = showReasoning ? (["Steps", "Reasoning", "Search"] as const) : (["Steps", "Search"] as const);

  useEffect(() => {
    if (tab === "Reasoning" && !showReasoning) setTab("Steps");
  }, [tab, showReasoning]);

  useEffect(() => {
    if (!resizingAgent) return;
    const onMove = (event: globalThis.PointerEvent) => {
      const start = agentResizeStart.current;
      if (!start) return;
      setAgentWidth(clampAgentWidth(start.width + start.clientX - event.clientX));
      setAgentCollapsed(false);
    };
    const stop = () => {
      agentResizeStart.current = null;
      setResizingAgent(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizingAgent]);

  function beginAgentResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    agentResizeStart.current = { clientX: event.clientX, width: agentCollapsed ? COLLAPSED_AGENT_WIDTH : agentWidth };
    setResizingAgent(true);
  }

  function resizeAgentWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 16;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = agentWidth + step;
    if (event.key === "ArrowRight") next = agentWidth - step;
    if (event.key === "Home") next = MIN_AGENT_WIDTH;
    if (event.key === "End") next = MAX_AGENT_WIDTH;
    if (next === null) return;
    event.preventDefault();
    setAgentWidth(clampAgentWidth(next));
    setAgentCollapsed(false);
  }

  return <aside className={`panel agent ${agentCollapsed ? "is-collapsed" : ""} ${resizingAgent ? "is-resizing" : ""}`} style={{ width: agentCollapsed ? COLLAPSED_AGENT_WIDTH : agentWidth }} aria-label="Agent panel">
    <div
      className="agent__resize"
      role="separator"
      tabIndex={0}
      aria-label="Resize agent panel"
      aria-orientation="vertical"
      aria-valuemin={MIN_AGENT_WIDTH}
      aria-valuemax={MAX_AGENT_WIDTH}
      aria-valuenow={agentWidth}
      aria-valuetext={agentCollapsed ? "Collapsed" : `${agentWidth} pixels`}
      onPointerDown={beginAgentResize}
      onKeyDown={resizeAgentWithKeyboard}
    />
    <div className="panel-h agent__head">
      <span className="agent__title">AGENT <span>{run ? run.workflow : "idle"}</span></span>
      <button type="button" className="agent__toggle" aria-controls="agent-panel" aria-expanded={!agentCollapsed} aria-label={agentCollapsed ? "Open agent panel" : "Collapse agent panel"} onClick={() => setAgentCollapsed((value) => !value)}>{agentCollapsed ? "‹" : "›"}</button>
    </div>
    <div id="agent-panel" className="agent__content" hidden={agentCollapsed}>
    {pendingScrape && <div className="ask">
      <h2>Start scrape?</h2>
      {scrapeIssues.length ? <p>{scrapeIssues.join(" ")}</p> : <p>Pi will search enabled sources and rank jobs. Nothing is selected for you.</p>}
      <div className="choices">
        {scrapeIssues.length ? <button onClick={() => navigate("#/disk")}>Open DISK and fix this</button> : <button onClick={onConfirmScrape}>Yes · scrape</button>}
        <button onClick={onCancelPending}>No</button>
      </div>
    </div>}
    {running && run?.workflow === "scrape" && <SurferLoader variant="tracker" label="Subway surfing" elapsed={elapsed} />}
    {running && run?.workflow !== "scrape" && <PixelLoader label={`${run?.workflow ?? "run"} playing`} elapsed={elapsed} />}
    <div className="think">
      <div className="think-h"><span className="pulse">{running ? "Thinking" : "Last trace"}</span>{!running && <span>{elapsed}</span>}</div>
      <div className="trace open">
        <div className="trace-tabs">
          {agentTabs.map((item) => <button key={item} className={`tbtn ${tab === item ? "on" : ""}`} onClick={() => setTab(item)}>{item}</button>)}
        </div>
        {tab === "Steps" && (rows.length ? rows.map((row) => <div className={`step ${taskClass(row.status)}`} key={row.taskId}><i className="dot" /><span>{row.label}{row.detail ? ` · ${row.detail}` : ""}</span><span>{row.status}</span></div>) : <p className="empty">No task events yet.</p>)}
        {tab === "Reasoning" && showReasoning && <p className="stream">{thought || "No reasoning captured for this run."}{running && <span className="caret" />}</p>}
        {tab === "Search" && <div className="code"><div className="code-h"><span>tool payload</span></div><pre>{search || "No tool payload yet."}</pre></div>}
      </div>
    </div>
    {tools.length > 0 && <div className="chips">{tools.map((name) => <span className="tchip tool" key={name}><i />{name}</span>)}</div>}
    {!running && !pendingScrape && !run && <div className="stream">
      Arm PLAY to scrape, or press Ctrl+K for commands. Stages never move unless you say so.
      <div className="sources"><span className="src">@profile</span><span className="src">@criteria</span></div>
      <div className="sel-actions"><button onClick={() => onFilter("Recommended")}>Show Recommended</button></div>
    </div>}
    </div>
  </aside>;
}
