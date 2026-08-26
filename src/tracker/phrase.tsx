import { useEffect, useMemo, useRef, useState } from "react";
import type { InterviewMessage, Job, Run } from "../shared.js";
import { api, getRun } from "../api.js";
import { trackerHref } from "./hash.js";
import { shouldRefreshActiveRun } from "./visibility.js";

export type PhraseStageFilter = "all" | "Applied" | "Interview";

export function isPhraseEligible(job: Pick<Job, "stage"> | null | undefined) {
  return job?.stage === "Applied" || job?.stage === "Interview";
}

export function filterPhraseJobs(jobs: readonly Job[], query: string, stage: PhraseStageFilter = "all") {
  const needle = query.trim().toLowerCase();
  return jobs.filter((job) => {
    if (!isPhraseEligible(job) || (stage !== "all" && job.stage !== stage)) return false;
    return !needle || `${job.company} ${job.role}`.toLowerCase().includes(needle);
  });
}

export function phraseActionState({ notes, savedNotes, messageCount, runActive, busy }: { notes: string; savedNotes: string; messageCount: number; runActive: boolean; busy: boolean }) {
  const dirty = notes !== savedNotes;
  return {
    dirty,
    canSaveNotes: dirty && !busy,
    canResetChat: messageCount > 0 && !runActive && !busy,
  };
}

export function PhraseView({ jobId, navigate, onRun, toast }: { jobId?: string; navigate: (href: string) => void; onRun: (run: Pick<Run, "id" | "workflow" | "status">) => void; toast: (message: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<PhraseStageFilter>("all");
  const [error, setError] = useState("");
  const [runActive, setRunActive] = useState(false);
  const dirtyNotes = useRef(false);

  useEffect(() => {
    void api<{ jobs: Job[] }>("/api/interview").then((result) => { setJobs(result.jobs); setError(""); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load interview jobs."));
  }, []);

  const visibleJobs = useMemo(() => filterPhraseJobs(jobs, search, stage), [jobs, search, stage]);
  const selected = visibleJobs.find((job) => job.id === jobId) ?? visibleJobs[0];

  function guardedNavigate(href: string) {
    if (dirtyNotes.current && !window.confirm("Interview notes are unsaved. Leave without saving?")) return;
    navigate(href);
  }

  return <>
    <aside className="panel">
      <div className="panel-h">ELIGIBLE <span>{visibleJobs.length}/{jobs.length}</span></div>
      <div className="phrase-filters" role="search" aria-label="Filter eligible PHRASE jobs">
        <label><span>SEARCH</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Company or role" /></label>
        <label><span>STAGE</span><select value={stage} onChange={(event) => setStage(event.target.value as PhraseStageFilter)}><option value="all">Applied + Interview</option><option value="Applied">Applied</option><option value="Interview">Interview</option></select></label>
        {(search || stage !== "all") && <button type="button" className="chip" onClick={() => { setSearch(""); setStage("all"); }}>CLEAR</button>}
      </div>
      {error && <div className="notice">{error}</div>}
      {!visibleJobs.length && !error && <p className="empty">{jobs.length ? "No eligible jobs match this filter." : "Applied and Interview jobs appear here after you mark Applied on SAMPLE."}</p>}
      {visibleJobs.map((job) => <button className={`ch ${selected?.id === job.id ? "on" : ""}`} key={job.id} disabled={runActive} onClick={() => guardedNavigate(trackerHref("phrase", job.id))}>
        <span className="n">{job.stage === "Interview" ? "INT" : "APP"}</span>
        <span className="ch-copy"><strong>{job.company}</strong><small>{job.role}</small></span>
        <span className="leds"><i className={`led ${job.interview_updated_at ? "g" : "o"}`} /></span>
      </button>)}
    </aside>
    {selected ? <PhraseWorkspace id={selected.id} navigate={guardedNavigate} onRun={onRun} toast={toast} onDirtyChange={(dirty) => { dirtyNotes.current = dirty; }} onRunActiveChange={setRunActive} /> : <section className="panel"><p className="empty">Pick an eligible job to practice. Practice does not change stage.</p></section>}
  </>;
}

function PhraseWorkspace({ id, navigate, onRun, toast, onDirtyChange, onRunActiveChange }: { id: string; navigate: (href: string) => void; onRun: (run: Pick<Run, "id" | "workflow" | "status">) => void; toast: (message: string) => void; onDirtyChange: (dirty: boolean) => void; onRunActiveChange: (active: boolean) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [messages, setMessages] = useState<InterviewMessage[]>([]);
  const [notes, setNotes] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [answer, setAnswer] = useState("");
  const [focus, setFocus] = useState("");
  const [runId, setRunId] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [error, setError] = useState("");
  const [streamText, setStreamText] = useState("");
  const [contextOpen, setContextOpen] = useState(() => {
    try { return window.localStorage.getItem("phrase.context") !== "closed"; } catch { return true; }
  });
  const sending = useRef(false);
  const notesDirty = useRef(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  async function load({ resetNotes = false } = {}) {
    if (resetNotes) {
      notesDirty.current = false;
      onDirtyChange(false);
    }
    const preserveDirtyNotes = !resetNotes && notesDirty.current;
    try {
      const value = await api<{ job: Job; messages: InterviewMessage[]; notes: string }>(`/api/jobs/${id}/interview`);
      setJob(value.job);
      setMessages(value.messages);
      if (!preserveDirtyNotes && !notesDirty.current) {
        setNotes(value.notes);
        setSavedNotes(value.notes);
        notesDirty.current = false;
        onDirtyChange(false);
      }
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load this practice workspace.");
    }
  }

  useEffect(() => { void load({ resetNotes: true }); }, [id]);
  useEffect(() => {
    if (!runId) return;
    // Live interviewer text; the poll loop below stays as the source of truth for run status.
    const source = new EventSource(`/api/jobs/${id}/interview/stream?runId=${encodeURIComponent(runId)}`);
    source.onmessage = (event) => {
      try { setStreamText(String((JSON.parse(event.data) as { text?: string }).text ?? "")); } catch { /* ignore malformed frame */ }
    };
    source.addEventListener("done", () => source.close());
    source.onerror = () => source.close();
    return () => source.close();
  }, [id, runId]);
  useEffect(() => {
    if (!runId) return;
    const checkRun = () => {
      if (!shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) return;
      void getRun(runId).then((run) => {
        if (run.status !== "running") {
          window.clearInterval(timer);
          setRunId("");
          setStreamText("");
          sending.current = false;
          onRunActiveChange(false);
          void load();
          if (run.status !== "succeeded") toast(run.error ?? "Previous messages were kept.");
        }
      }).catch(() => undefined);
    };
    const onVisibility = () => {
      if (shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) checkRun();
    };
    const onFocus = () => {
      if (shouldRefreshActiveRun(document.visibilityState, document.hasFocus())) checkRun();
    };
    const timer = window.setInterval(checkRun, 800);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [runId]);
  useEffect(() => {
    const dirty = notes !== savedNotes;
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [notes, savedNotes]);
  useEffect(() => {
    const el = msgsRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamText]);

  function pinOnScroll() {
    const el = msgsRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  const actions = phraseActionState({ notes, savedNotes, messageCount: messages.length, runActive: Boolean(runId), busy: notesBusy || resetBusy });

  async function send(message = answer) {
    if (!message.trim() || sending.current) return;
    sending.current = true;
    try {
      const result = await api<{ runId: string }>(`/api/jobs/${id}/interview`, { method: "POST", body: JSON.stringify({ message, focus }) });
      setMessages((previous) => [...previous, { role: "user", content: message, createdAt: new Date().toISOString() }]);
      setStreamText("");
      setRunId(result.runId);
      onRunActiveChange(true);
      setAnswer("");
      onRun({ id: result.runId, workflow: "interview", status: "running" });
    } catch (caught) {
      sending.current = false;
      toast(caught instanceof Error ? caught.message : "Message failed. Previous messages were kept.");
    }
  }

  function updateNotes(value: string) {
    setNotes(value);
    const dirty = value !== savedNotes;
    notesDirty.current = dirty;
    onDirtyChange(dirty);
  }

  async function saveNotes() {
    if (!actions.canSaveNotes) return;
    setNotesBusy(true);
    try {
      const value = await api<Job>(`/api/jobs/${id}/interview`, { method: "PATCH", body: JSON.stringify({ notes }) });
      const persisted = value.interview_notes ?? "";
      setJob(value);
      setNotes(persisted);
      setSavedNotes(persisted);
      notesDirty.current = false;
      onDirtyChange(false);
      toast("Interview notes saved.");
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Notes were not saved.");
    } finally {
      setNotesBusy(false);
    }
  }

  async function resetChat() {
    if (!job || !actions.canResetChat) return;
    setResetBusy(true);
    try {
      const value = await api<Job>(`/api/jobs/${id}/interview`, { method: "DELETE" });
      setJob(value);
      setMessages(value.interview_messages ?? []);
      setResetOpen(false);
      toast("Practice chat reset. Notes and stage were kept.");
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Chat was not reset.");
    } finally {
      setResetBusy(false);
    }
  }

  function toggleContext() {
    const next = !contextOpen;
    setContextOpen(next);
    try { window.localStorage.setItem("phrase.context", next ? "open" : "closed"); } catch { /* storage is optional */ }
  }

  return <section className="panel phrase-panel">
    <div className="panel-h">
      <span>PHRASE · {job ? `${job.company} / ${job.role}` : "loading"}</span>
      <span className="phrase-head-actions">
        {job && <button type="button" className={`chip ${contextOpen ? "on" : ""}`} aria-expanded={contextOpen} aria-controls="phrase-context" onClick={toggleContext}>{contextOpen ? "HIDE CONTEXT" : "SHOW CONTEXT"}</button>}
        <button className="chip" onClick={() => navigate(trackerHref("sample", id))}>SAMPLE</button>
      </span>
    </div>
    <div className="phrase-body">
      <div className="phrase-chat">
        {error && <div className="notice">{error}</div>}
        <div className="msgs" aria-live="polite" ref={msgsRef} onScroll={pinOnScroll}>
          {messages.length === 0 && !runId && <article className="msg"><div className="who">READY</div><div className="body">Start with a focus or send an answer. Practice uses the stored job, profile, and documents. It does not change the job stage.</div></article>}
          {messages.map((message, index) => <article className={`msg ${message.role === "user" ? "you" : ""}`} key={`${message.createdAt}-${index}`}>
            <div className="who">{message.role === "assistant" ? "INTERVIEWER / FEEDBACK" : "YOU"}</div>
            <div className="body">{message.content}</div>
          </article>)}
          {runId && <article className="msg"><div className="who">INTERVIEWER</div><div className="body">{streamText || "Interviewer is thinking..."}<span className="caret" /></div></article>}
        </div>
        <form className="phrase-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <select value={focus} onChange={(event) => setFocus(event.target.value)} aria-label="Interview practice focus">
            <option value="">Choose a focus</option>
            <option>Behavioral interview</option>
            <option>Java / Spring technical</option>
            <option>System design</option>
            <option>Role-specific gaps</option>
            <option>Hiring-manager interview</option>
          </select>
          <textarea rows={4} value={answer} disabled={Boolean(runId)} placeholder={runId ? "Waiting for interviewer..." : "Answer from your own experience..."} onChange={(event) => setAnswer(event.target.value)} aria-label="Interview answer" />
          <div className="sel-actions">
            <button type="button" disabled={!actions.canResetChat} onClick={() => setResetOpen(true)}>Reset chat</button>
            <button type="button" disabled={Boolean(runId)} onClick={() => void send("Please start the mock interview with one question.")}>Start practice</button>
            <button className="send" type="submit" disabled={Boolean(runId) || !answer.trim()}>{runId ? "Sending..." : "SEND"}</button>
          </div>
          {resetOpen && <div className="phrase-confirm" role="alertdialog" aria-label="Confirm reset chat"><p>Clear saved practice messages? Private notes and job stage stay unchanged.</p><div><button type="button" onClick={() => setResetOpen(false)}>Cancel</button><button type="button" disabled={resetBusy} onClick={() => void resetChat()}>Confirm reset</button></div></div>}
        </form>
      </div>
      {job && <aside id="phrase-context" className={`phrase-context ${contextOpen ? "" : "is-collapsed"}`} aria-label="Job context for interview practice" aria-hidden={!contextOpen}>
        <div className="phrase-context__facts">
          <div><span>COMPANY</span><strong>{job.company}</strong></div>
          <div><span>ROLE</span><strong>{job.role}</strong></div>
          <div><span>LOCATION</span><strong>{job.location || "Not specified"}</strong></div>
          <div><span>SCORE</span><strong className="phrase-score">{job.score}</strong></div>
          <div><span>STAGE</span><strong>{job.stage}</strong></div>
          <div><span>CV / COVER LETTER</span><strong>{job.cv_source || job.cv_pdf ? "CV AVAILABLE" : "CV NOT GENERATED"} · {job.cover_letter_source || job.cover_letter_pdf ? "LETTER AVAILABLE" : "LETTER NOT GENERATED"}</strong></div>
        </div>
        <div className="phrase-context__fit">
          <article><h2>STRENGTHS</h2>{job.rank.strengths.length ? <ul>{job.rank.strengths.map((item) => <li key={item}>{item}</li>)}</ul> : <p>None recorded.</p>}</article>
          <article><h2>GAPS / REQUIREMENTS TO CONFIRM</h2>{job.rank.gaps.length ? <ul>{job.rank.gaps.map((item) => <li key={item}>{item}</li>)}</ul> : <p>None recorded.</p>}</article>
        </div>
        <section className="phrase-context__posting"><div className="phrase-context__section-head"><h2>POSTING / REQUIREMENTS</h2><span>{job.posting ? "STORED SOURCE" : "NOT STORED"}</span></div><div className="posting">{job.posting || "No posting text was stored."}</div></section>
        <section className="phrase-context__notes">
          <div className="phrase-context__section-head"><h2>PRIVATE INTERVIEW NOTES</h2><span>{actions.dirty ? "UNSAVED" : "SAVED"}</span></div>
          <textarea rows={4} value={notes} onChange={(event) => updateNotes(event.target.value)} placeholder="Interview date, interviewer, questions, observations" aria-label="Private interview notes" tabIndex={contextOpen ? 0 : -1} />
          <div className="phrase-notes-actions"><button type="button" tabIndex={contextOpen ? 0 : -1} disabled={!actions.canSaveNotes} onClick={() => void saveNotes()}>{notesBusy ? "SAVING..." : actions.dirty ? "SAVE NOTES" : "SAVED"}</button></div>
        </section>
      </aside>}
    </div>
  </section>;
}
