import { useEffect, useMemo, useRef, useState } from "react";
import type { Criteria, Job, JobStage, Run, Settings, TrajectoryEvent } from "../shared.js";
import { jobSourceLabel } from "../shared.js";
import { api, getActiveRun, getCriteria, getJobs, getProfile, getRun, getRunTrajectory, getSettings } from "../api.js";
import { drawSquareWave, stopTrackerTune } from "./audio.js";
import { ActiveRunStrip } from "./agent.js";
import { TapeDeck } from "./tape-deck.js";
import { DiskView } from "./disk.js";
import { parseTrackerHash, TRACKER_VIEWS, trackerHref, orderTabLabel, type OrderFocus, type TrackerRoute } from "./hash.js";
import { OrderView } from "./order.js";
import { PatternView } from "./pattern.js";
import { PhraseView } from "./phrase.js";
import { SampleView } from "./sample.js";
import { createRunSyncChannel, TraceView } from "./trace.js";
import { shouldRefreshActiveRun } from "./visibility.js";
import { WorkflowRack } from "./workflow-rack.js";
import { WORKFLOW_CHANNELS, type WorkflowChannelId } from "./workflow.js";
import { useWorkflowCues } from "../workflow-cues.js";
import "./studio.css";

const summaryStages: JobStage[] = ["Recommended", "Discarded", "Selected", "Drafting", "Ready", "Applied", "Interview", "Offer", "Rejected", "Archived"];
const commands = [
  ["/scrape", "Play scrape on armed sources"],
  ["/generate", "Render CV + letter for Selected rows"],
  ["/interview", "Open phrase editor"],
  ["/import", "Paste a posting into a new row"],
  ["/disk", "Open profile and settings"],
];

export function TrackerApp() {
  const [route, setRoute] = useState<TrackerRoute>(() => parseTrackerHash());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [filter, setFilter] = useState<JobStage | "all">("all");
  const [orderFocus, setOrderFocus] = useState<OrderFocus>("draft");
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<TrajectoryEvent[]>([]);
  const [toast, setToast] = useState("");
  const [pendingScrape, setPendingScrape] = useState(false);
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const [tapeOpen, setTapeOpen] = useState(false);
  const [tapeLive, setTapeLive] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [clock, setClock] = useState("");
  const osc = useRef<HTMLCanvasElement>(null);
  const currentRunId = useRef<string | null>(null);
  const syncRef = useRef<ReturnType<typeof createRunSyncChannel> | null>(null);
  useWorkflowCues(run);

  function navigate(href: string) {
    const request = { allowed: true };
    window.dispatchEvent(new CustomEvent("jobdesk:navigation-request", { detail: request }));
    if (!request.allowed) return;
    window.location.hash = href.replace(/^#/, "");
  }
  useEffect(() => {
    const onHash = () => {
      const next = parseTrackerHash();
      setRoute(next);
      if (next.orderFocus) setOrderFocus(next.orderFocus);
    };
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) window.location.hash = "/pattern";
    onHash();
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  async function reloadJobs() {
    const result = await getJobs(summaryStages);
    setJobs(result.jobs);
  }
  useEffect(() => {
    void getSettings().then(setSettings).catch(() => undefined);
    void getCriteria().then(setCriteria).catch(() => undefined);
    void getProfile().then((result) => setProfileReady(result.canonical && Boolean(result.profile.identity.firstName || result.profile.identity.summary))).catch(() => undefined);
    void reloadJobs().catch(() => undefined);
  }, []);

  function observeRun(next: Run | null) {
    currentRunId.current = next?.id ?? null;
    setRun(next);
    if (!next) setEvents([]);
  }
  useEffect(() => {
    const onStarted = (event: Event) => {
      const next = (event as CustomEvent<Run>).detail;
      observeRun(next);
      syncRef.current?.notify(next.id);
    };
    window.addEventListener("jobdesk:run-started", onStarted);
    return () => window.removeEventListener("jobdesk:run-started", onStarted);
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const refreshActiveRun = async () => {
      if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) return;
      try {
        const result = await getActiveRun();
        if (!disposed) observeRun(result.run);
      } catch { /* API polling is retried on the next tick or focus event */ }
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) {
        stop();
        return;
      }
      if (timer !== undefined) return;
      void refreshActiveRun();
      timer = window.setInterval(() => void refreshActiveRun(), 1_200);
    };
    const channel = createRunSyncChannel(() => {
      if (shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) void refreshActiveRun();
    });
    syncRef.current = channel;
    const onVisibility = () => start();
    const onFocus = () => start();
    const onBlur = () => stop();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    start();
    return () => {
      disposed = true;
      channel.close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      if (syncRef.current === channel) syncRef.current = null;
      stop();
    };
  }, [route]);
  useEffect(() => {
    if (!run) return;
    const id = run.id;
    let disposed = false;
    const refresh = async () => {
      if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) return;
      const [runResult, trajectoryResult] = await Promise.allSettled([getRun(id), getRunTrajectory(id)]);
      if (disposed || currentRunId.current !== id) return;
      if (runResult.status === "fulfilled") {
        const previous = run.status;
        observeRun(runResult.value);
        if (previous === "running" && runResult.value.status !== "running") void reloadJobs();
      }
      if (trajectoryResult.status === "fulfilled") setEvents(trajectoryResult.value.events);
    };
    void refresh();
    if (run.status !== "running") return () => { disposed = true; };
    const timer = window.setInterval(() => void refresh(), 800);
    const onVisibility = () => void refresh();
    const onFocus = () => void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [run?.id, run?.status]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const date = new Date();
      setNow(date.getTime());
      setClock([date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":"));
      if (osc.current) drawSquareWave(osc.current, Boolean(run?.status === "running" || tapeLive), date.getTime());
    }, 80);
    return () => window.clearInterval(timer);
  }, [run?.status, tapeLive]);
  useEffect(() => () => stopTrackerTune(), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
        setQuery("");
      }
      if (event.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const scrapeIssues = useMemo(() => {
    const issues = [];
    if (!profileReady) issues.push("Save a structured profile first.");
    if (!criteria?.roles.length || !criteria.locations.length) issues.push("Add at least one target role and location.");
    if (!settings?.model) issues.push("Select a provider model on DISK.");
    return issues;
  }, [profileReady, criteria, settings]);
  const enabledLabels = settings ? (settings.enabledSources?.length ? settings.enabledSources : [settings.source]).map((source) => jobSourceLabel(source, settings.customSources ?? [])).join(", ") : "…";
  const running = run?.status === "running";
  const playIndex = running ? Math.floor(now / 400) : 0;
  const hits = commands.filter((item) => item.join(" ").toLowerCase().includes(query.toLowerCase()));

  function announce(next: { id: string; workflow: Run["workflow"]; status: Run["status"] }) {
    window.dispatchEvent(new CustomEvent("jobdesk:run-started", { detail: {
      id: next.id,
      workflow: next.workflow,
      status: next.status,
      provider: settings?.provider ?? "",
      model: settings?.model ?? "",
      summary: null,
      started_at: new Date().toISOString(),
    } satisfies Run }));
  }
  async function startManualImport(input: string) {
    if (running) throw new Error("Another AI run is already active.");
    const result = await api<{ runId: string }>("/api/jobs/manual", { method: "POST", body: JSON.stringify({ input }) });
    announce({ id: result.runId, workflow: "manual_import", status: "running" });
    setToast("Manual import started.");
  }
  async function runCommand(value: string) {
    const text = value.trim();
    if (!text) return;
    if (text.startsWith("/scrape")) { setPendingScrape(true); navigate("#/pattern"); return; }
    if (text.startsWith("/generate")) { setOrderFocus("draft"); void generate(jobs.filter((job) => job.stage === "Selected").map((job) => job.id)); navigate(trackerHref("order", undefined, "draft")); return; }
    if (text.startsWith("/interview")) { navigate("#/phrase"); return; }
    if (text.startsWith("/disk")) { navigate("#/disk"); return; }
    if (text.startsWith("/import")) {
      const input = text.replace(/^\/import\s*/i, "");
      if (!input) { setToast("Usage: /import <url or pasted posting>"); return; }
      try { await startManualImport(input); }
      catch (caught) { setToast(caught instanceof Error ? caught.message : "Import failed."); }
      return;
    }
    setToast("Use a /command. Pi does not take freeform workspace chat.");
  }
  async function confirmScrape() {
    setPendingScrape(false);
    try {
      const result = await api<{ runId: string }>("/api/scrape", { method: "POST" });
      announce({ id: result.runId, workflow: "scrape", status: "running" });
      setToast("Scrape playing. SELECT stays muted until you arm it.");
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Scrape could not start."); }
  }
  async function generate(ids: string[]) {
    if (!ids.length) { setToast("Arm SELECT rows first."); return; }
    try {
      const result = await api<{ runId: string }>("/api/generate", { method: "POST", body: JSON.stringify({ jobIds: ids }) });
      announce({ id: result.runId, workflow: "generate", status: "running" });
      setToast("Generation started.");
    } catch (caught) { setToast(caught instanceof Error ? caught.message : "Generate could not start."); }
  }
  async function cancelRun() {
    if (!run) return;
    try { await api(`/api/runs/${run.id}/cancel`, { method: "POST" }); syncRef.current?.notify(run.id); setToast("Cancel requested."); }
    catch (caught) { setToast(caught instanceof Error ? caught.message : "Could not cancel."); }
  }
  function activateChannel(id: WorkflowChannelId) {
    const channel = WORKFLOW_CHANNELS.find((item) => item.id === id);
    if (!channel) return;
    if (channel.action === "scrape") {
      setPendingScrape(true);
      setFilter("all");
      navigate(trackerHref("pattern"));
      return;
    }
    if (channel.filter) setFilter(channel.filter);
    if (channel.orderFocus) setOrderFocus(channel.orderFocus);
    navigate(trackerHref(channel.view, undefined, channel.orderFocus));
  }

  const agentProps = {
    run, events, pendingScrape, scrapeIssues,
    onConfirmScrape: () => void confirmScrape(),
    onCancelPending: () => setPendingScrape(false),
    navigate, onFilter: setFilter, now,
  };

  return <div className="studio">
    <header className="transport">
      <div className="brand">
        <div className="logo" aria-hidden="true" />
        <div><strong>TRACKER</strong><span>local agent · 127.0.0.1</span></div>
      </div>
      <div className="transport-ctrls">
        <button className="ico play" title="Start scrape" aria-label="Play scrape" onClick={() => { setPendingScrape(true); navigate("#/pattern"); }}>
          <svg viewBox="0 0 14 14"><path d="M3 1v12l10-6z" /></svg>
        </button>
        <div className={`meter-wrap ${running || tapeLive ? "live" : ""}`} aria-hidden="true"><i style={{ height: 8 }} /><i style={{ height: 14 }} /><i style={{ height: 6 }} /><i style={{ height: 18 }} /></div>
        <canvas className="osc" ref={osc} width={120} height={28} aria-hidden="true" />
      </div>
      <div className="transport-meta">
        <span>FIT <b>&gt;{settings?.scoreThreshold ?? 60}</b></span>
        <span>SRC <b>{enabledLabels}</b></span>
        <span>MDL <b>{settings?.model || "none"}</b></span>
        <span>CMD <b>Ctrl+K</b></span>
        <span className="clock">{clock}</span>
      </div>
    </header>
    <div className="tape-shell">
      <TapeDeck open={tapeOpen} onToggle={() => setTapeOpen((value) => !value)} onLiveChange={setTapeLive} toast={setToast} />
      <ActiveRunStrip run={run} events={events} now={now} navigate={navigate} onCancel={() => void cancelRun()} />
    </div>
    <nav className="modes" aria-label="Editor">
      {TRACKER_VIEWS.filter((view) => view !== "sample" || (route.view === "sample" && Boolean(route.jobId))).map((view) => { const id = view === "trace" && route.view === "trace" ? route.runId : view === route.view ? route.jobId : undefined; const href = trackerHref(view, id, view === "order" ? orderFocus : undefined); return <a key={view} className={route.view === view ? "on" : ""} href={href} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(href); }}>{orderTabLabel(view)}</a>; })}
    </nav>
    <div className={`workspace ${route.view}`}>
      {["pattern", "order", "phrase"].includes(route.view) && (
        <WorkflowRack jobs={jobs} route={route} filter={filter} orderFocus={orderFocus} onChannel={activateChannel} />
      )}
      {route.view === "pattern" && <PatternView jobs={jobs} settings={settings} filter={filter} playIndex={playIndex} running={running} onManualImport={startManualImport} {...agentProps} />}
      {route.view === "order" && <OrderView jobs={jobs} orderFocus={orderFocus} onGenerate={(ids) => void generate(ids)} navigate={navigate} run={run} onRun={announce} onReload={() => void reloadJobs()} toast={setToast} />}
      {route.view === "phrase" && <PhraseView jobId={route.jobId} navigate={navigate} onRun={announce} toast={setToast} />}
      {route.view === "sample" && <SampleView jobId={route.jobId} settings={settings} navigate={navigate} toast={setToast} onRun={announce} onReload={() => void reloadJobs()} run={run} />}
      {route.view === "disk" && <DiskView toast={setToast} onSettings={setSettings} />}
      {route.view === "trace" && <TraceView runId={route.runId} activeRun={run} navigate={navigate} now={now} />}
    </div>
    {toast && <div className="toast" role="status">{toast}</div>}
    <div className={`palette ${palette ? "open" : ""}`} onClick={(event) => { if (event.target === event.currentTarget) setPalette(false); }}>
      <div className="box">
        <input autoFocus value={query} placeholder="Search commands…" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && hits[0]) { setPalette(false); void runCommand(hits[0][0]); }
        }} />
        <div className="palette-list">
          {hits.map((item, index) => <button className={index === 0 ? "on" : ""} key={item[0]} onClick={() => { setPalette(false); void runCommand(item[0]); }}><b>{item[0]}</b> — {item[1]}</button>)}
        </div>
      </div>
    </div>
  </div>;
}
