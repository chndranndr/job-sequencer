import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { DocumentVerification, Job, JobStage, Run, Settings } from "../shared.js";
import { jobSourceLabel } from "../shared.js";
import { api, getJob } from "../api.js";
import { trackerHref } from "./hash.js";
import { scoreToNote } from "./notes.js";

export type SampleAction =
  | "select"
  | "unselect"
  | "restore-recommended"
  | "restore"
  | "generate"
  | "regenerate"
  | "approve"
  | "apply"
  | "phrase"
  | "outcome"
  | "archive";

export type VerificationCheck = {
  key: keyof DocumentVerification;
  label: string;
  value: string;
  pass: boolean;
};

export function sampleStageActions(stage: JobStage): SampleAction[] {
  switch (stage) {
    case "Recommended": return ["select", "archive"];
    case "Discarded": return ["restore-recommended", "archive"];
    case "Selected": return ["unselect", "generate", "archive"];
    case "Drafting": return ["regenerate", "approve", "archive"];
    case "Ready": return ["apply", "archive"];
    case "Applied":
    case "Interview": return ["phrase", "outcome", "archive"];
    case "Offer":
    case "Rejected": return ["archive"];
    case "Archived": return ["restore"];
  }
}

export function canStartSampleRun(globalRunActive: boolean, localStartPending: boolean) {
  return !globalRunActive && !localStartPending;
}

export function canApproveSampleDocuments(verification: DocumentVerification | null | undefined) {
  return verification?.success === true;
}

export function verificationChecks(verification: DocumentVerification | null | undefined): VerificationCheck[] {
  return [
    { key: "success", label: "Overall verification", value: verification ? (verification.success ? "PASSED" : "FAILED") : "PENDING", pass: verification?.success === true },
    { key: "cvPages", label: "CV page count", value: verification ? String(verification.cvPages) : "—", pass: Boolean(verification && verification.cvPages > 0) },
    { key: "coverLetterPages", label: "Cover-letter page count", value: verification ? String(verification.coverLetterPages) : "—", pass: Boolean(verification && verification.coverLetterPages > 0) },
    { key: "cvTextPresent", label: "CV text present", value: verification ? (verification.cvTextPresent ? "YES" : "NO") : "PENDING", pass: verification?.cvTextPresent === true },
    { key: "coverLetterTextPresent", label: "Cover-letter text present", value: verification ? (verification.coverLetterTextPresent ? "YES" : "NO") : "PENDING", pass: verification?.coverLetterTextPresent === true },
    { key: "emailPresent", label: "Email present", value: verification ? (verification.emailPresent ? "YES" : "NO") : "PENDING", pass: verification?.emailPresent === true },
    { key: "phonePresent", label: "Phone present", value: verification ? (verification.phonePresent ? "YES" : "NO") : "PENDING", pass: verification?.phonePresent === true },
    { key: "checkedAt", label: "Checked at", value: verification?.checkedAt ?? "—", pass: Boolean(verification?.checkedAt) },
  ];
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function documentStatus(job: Job) {
  if (job.approved_at) return "Approved";
  if (job.verification?.success) return "Verified · awaiting approval";
  if (job.cv_source || job.cover_letter_source) return "Generated · review needed";
  return "Not generated";
}

const MIN_INSPECTOR_WIDTH = 260;
const MAX_INSPECTOR_WIDTH = 420;
const COLLAPSED_INSPECTOR_WIDTH = 48;

function clampInspectorWidth(value: number) {
  return Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, value));
}

export function SampleView({ jobId, settings, navigate, toast, onRun, onReload, run }: {
  jobId?: string;
  settings: Settings | null;
  navigate: (href: string) => void;
  toast: (message: string) => void;
  onRun: (detail: { id: string; workflow: "generate"; status: "running" }) => void;
  onReload: () => void;
  run: Run | null;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const [applicationNotes, setApplicationNotes] = useState("");
  const [confirm, setConfirm] = useState<"archive" | "restore-recommended" | "restore" | "approval" | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [runStarting, setRunStarting] = useState<"generate" | "regenerate" | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(280);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [resizingInspector, setResizingInspector] = useState(false);
  const inspectorResizeStart = useRef<{ clientX: number; width: number } | null>(null);

  const syncJob = useCallback((value: Job) => {
    setJob(value);
    setNotes(value.notes ?? "");
    setApplicationNotes(value.application_notes ?? "");
  }, []);
  const load = useCallback(async () => {
    if (!jobId) return;
    try {
      syncJob(await getJob(jobId));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Job not found.");
    }
  }, [jobId, syncJob]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (run?.workflow === "generate" && run.status !== "running") void load();
  }, [load, run?.id, run?.status, run?.workflow]);
  useEffect(() => {
    if (!resizingInspector) return;
    const onMove = (event: globalThis.PointerEvent) => {
      const start = inspectorResizeStart.current;
      if (!start) return;
      setInspectorWidth(clampInspectorWidth(start.width + start.clientX - event.clientX));
      setInspectorCollapsed(false);
    };
    const stop = () => {
      inspectorResizeStart.current = null;
      setResizingInspector(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizingInspector]);

  function beginInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    inspectorResizeStart.current = { clientX: event.clientX, width: inspectorCollapsed ? COLLAPSED_INSPECTOR_WIDTH : inspectorWidth };
    setResizingInspector(true);
  }

  function resizeInspectorWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 16;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = inspectorWidth + step;
    if (event.key === "ArrowRight") next = inspectorWidth - step;
    if (event.key === "Home") next = MIN_INSPECTOR_WIDTH;
    if (event.key === "End") next = MAX_INSPECTOR_WIDTH;
    if (next === null) return;
    event.preventDefault();
    setInspectorWidth(clampInspectorWidth(next));
    setInspectorCollapsed(false);
  }

  async function act(path: string, method = "POST", body?: unknown, message = "Workflow updated.") {
    if (busyAction) return;
    setBusyAction(path);
    try {
      syncJob(await api<Job>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      await load();
      onReload();
      toast(message);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Workflow was not updated.");
    } finally {
      setBusyAction(null);
    }
  }

  async function saveNotes(kind: "personal" | "application") {
    if (!jobId || busyAction) return;
    const path = `notes:${kind}`;
    setBusyAction(path);
    try {
      const value = await api<Job>(`/api/jobs/${jobId}`, {
        method: "PATCH",
        body: JSON.stringify(kind === "personal" ? { notes } : { applicationNotes }),
      });
      setJob(value);
      if (kind === "personal") setNotes(value.notes ?? "");
      else setApplicationNotes(value.application_notes ?? "");
      toast(`${kind === "personal" ? "Personal" : "Application"} notes saved.`);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Notes were not saved.");
    } finally {
      setBusyAction(null);
    }
  }

  async function startGeneration(kind: "generate" | "regenerate") {
    if (!canStartSampleRun(run?.status === "running", Boolean(runStarting))) {
      toast("Another run is already active.");
      return;
    }
    if (!jobId) return;
    setRunStarting(kind);
    try {
      const result = await api<{ runId: string }>(kind === "generate" ? "/api/generate" : `/api/jobs/${jobId}/regenerate`, {
        method: "POST",
        ...(kind === "generate" ? { body: JSON.stringify({ jobIds: [jobId] }) } : {}),
      });
      onRun({ id: result.runId, workflow: "generate", status: "running" });
      toast(kind === "generate" ? "Generation started." : "Regeneration started.");
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Generation failed.");
    } finally {
      setRunStarting(null);
    }
  }

  if (!jobId) return <section className="panel" style={{ gridColumn: "1 / -1" }}><p className="empty">Open a row from PATTERN to inspect a sample.</p></section>;
  if (error || !job) return <section className="panel" style={{ gridColumn: "1 / -1" }}><p className="empty">{error || "Loading sample…"}</p></section>;

  const actions = sampleStageActions(job.stage);
  const hasAction = (action: SampleAction) => actions.includes(action);
  const verified = canApproveSampleDocuments(job.verification);
  const runActive = run?.status === "running";
  const checks = verificationChecks(job.verification);

  return <>
    <section className="panel sample-panel">
      <div className="panel-h">SAMPLE · {job.company} <a href={trackerHref("pattern")} onClick={(event) => { event.preventDefault(); navigate("#/pattern"); }}>PATTERN</a></div>
      <div className="sample-scroll">
        <header className="sample-head">
          <div>
            <div className="sample-eyebrow">{jobSourceLabel(job.source, settings?.customSources ?? [])}</div>
            <h1>{job.role}</h1>
            <p>{job.company} · {job.location || "Not specified"}</p>
          </div>
          <div className="sample-stage">{job.stage.toUpperCase()}</div>
        </header>

        <dl className="sample-facts">
          <div><dt>Source URL</dt><dd>{/^https?:\/\//i.test(job.url) ? <a href={job.url} target="_blank" rel="noreferrer">{job.url}</a> : job.url || "Not specified"}</dd></div>
          <div><dt>Status</dt><dd>{job.stage}</dd></div>
          <div><dt>First seen</dt><dd>{formatDate(job.first_seen_at)}</dd></div>
          <div><dt>Updated</dt><dd>{formatDate(job.updated_at)}</dd></div>
        </dl>

        <section className="sample-section">
          <div className="sample-section-head"><h2>FIT ASSESSMENT</h2><span className="sample-score">{job.score} · {scoreToNote(job.score)}</span></div>
          <p className="sample-reason">{job.rank.reason || "No ranking explanation recorded."}</p>
          <div className="chunks sample-chunks">
            <article className="chunk"><b>Strengths</b>{job.rank.strengths.length ? <ul>{job.rank.strengths.map((item) => <li key={item}>{item}</li>)}</ul> : <p>None recorded.</p>}<div className="from">rank.json</div></article>
            <article className="chunk"><b>Gaps / confirm</b>{job.rank.gaps.length ? <ul>{job.rank.gaps.map((item) => <li key={item}>{item}</li>)}</ul> : <p>None recorded.</p>}<div className="from">rank.json</div></article>
          </div>
        </section>

        <section className="sample-section">
          <div className="sample-section-head"><h2>FULL POSTING</h2>{/^https?:\/\//i.test(job.url) ? <a href={job.url} target="_blank" rel="noreferrer">Open source ↗</a> : <span>Imported manually</span>}</div>
          <div className="posting sample-posting">{job.posting || "No posting text was stored."}</div>
        </section>

        <section className="sample-section">
          <div className="sample-verification">
            <div className="sample-section-head"><h3>VERIFICATION</h3><span className={verified ? "stage-g" : "stage-o"}>{verified ? "PASSED" : "NEEDS REVIEW"}</span></div>
            <table className="diff"><thead><tr><th>Check</th><th>Value</th><th>State</th></tr></thead><tbody>
              {checks.map((check) => <tr key={check.key}><td>{check.label}</td><td>{check.key === "checkedAt" ? formatDate(check.value) : check.value}</td><td className={check.pass ? "add" : ""}>{check.pass ? "PASS" : "PENDING"}</td></tr>)}
            </tbody></table>
          </div>
          <p className="sample-rule">Verification success remains separate from approval. Review both documents, then confirm approval manually.</p>
        </section>

        <section className="sample-section">
          <div className="sample-section-head"><h2>APPLICATION RECORD</h2><span>{job.stage}</span></div>
          <dl className="sample-status-list">
            <div><dt>Approval</dt><dd>{job.approved_at ? `Approved ${formatDate(job.approved_at)}` : verified ? "Verified; awaiting approval" : "Not approved"}</dd></div>
            <div><dt>Submission</dt><dd>{job.submitted_at ? `${formatDate(job.submitted_at)} · ${job.submission_channel || "Channel not recorded"}` : "Not marked Applied"}</dd></div>
            <div><dt>Follow-up</dt><dd>{job.follow_up_sent_at ? `Marked sent ${formatDate(job.follow_up_sent_at)}` : job.follow_up_draft ? job.follow_up_due_at ? `Draft saved · due ${formatDate(job.follow_up_due_at)}` : "Draft saved" : "Not drafted"}</dd></div>
            <div><dt>Outcome</dt><dd>{job.stage === "Offer" || job.stage === "Rejected" ? job.stage : job.stage === "Interview" ? "Interview" : "No outcome recorded"}</dd></div>
          </dl>
        </section>

        <section className="sample-section sample-notes">
          <div className="sample-section-head"><h2>NOTES</h2><span>Separate records</span></div>
          <div className="two">
            <label className="field">Personal notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Private context about this role." /></label>
            <label className="field">Application notes<textarea value={applicationNotes} onChange={(event) => setApplicationNotes(event.target.value)} placeholder="Submission or outcome notes." /></label>
          </div>
          <div className="sample-note-actions">
            <button disabled={busyAction !== null} onClick={() => void saveNotes("personal")}>{busyAction === "notes:personal" ? "Saving…" : "Save personal notes"}</button>
            <button disabled={busyAction !== null} onClick={() => void saveNotes("application")}>{busyAction === "notes:application" ? "Saving…" : "Save application notes"}</button>
          </div>
        </section>
      </div>
    </section>

    <aside className={`panel sample-aside ${inspectorCollapsed ? "is-collapsed" : ""} ${resizingInspector ? "is-resizing" : ""}`} style={{ width: inspectorCollapsed ? COLLAPSED_INSPECTOR_WIDTH : inspectorWidth }} aria-label="Sample inspector">
      <div
        className="sample-aside__resize"
        role="separator"
        tabIndex={0}
        aria-label="Resize inspector"
        aria-orientation="vertical"
        aria-valuemin={MIN_INSPECTOR_WIDTH}
        aria-valuemax={MAX_INSPECTOR_WIDTH}
        aria-valuenow={inspectorWidth}
        aria-valuetext={inspectorCollapsed ? "Collapsed" : `${inspectorWidth} pixels`}
        onPointerDown={beginInspectorResize}
        onKeyDown={resizeInspectorWithKeyboard}
      />
      <div className="sample-aside__head">
        <span className="sample-aside__title">INSPECTOR</span>
        <button type="button" className="sample-aside__toggle" aria-controls="sample-inspector" aria-expanded={!inspectorCollapsed} aria-label={inspectorCollapsed ? "Open inspector" : "Collapse inspector"} onClick={() => setInspectorCollapsed((value) => !value)}>{inspectorCollapsed ? "OPEN" : "CLOSE"}</button>
      </div>
      <div id="sample-inspector" className="sample-aside__content" hidden={inspectorCollapsed}>
      <div className="tune">
        <h2>Inspector</h2>
        <div className="slats"><div className="slat"><span>FIT VOL</span><input type="range" min={0} max={100} value={Number.isFinite(job.score) ? job.score : 0} disabled /><span>{job.score}</span></div></div>
        <p className="sample-boundary">Opening a posting is external only. This tracker never submits, emails, or advances the workflow automatically.</p>
        <div className="choices">
          {hasAction("select") && <button disabled={busyAction !== null} onClick={() => void act(`/api/jobs/${job.id}/select`, "POST", undefined, "Job selected.")}>Select</button>}
          {hasAction("unselect") && <button disabled={busyAction !== null} onClick={() => void act(`/api/jobs/${job.id}/select`, "POST", undefined, "Job unselected.")}>Unselect</button>}
          {hasAction("restore-recommended") && <button disabled={busyAction !== null} onClick={() => setConfirm("restore-recommended")}>Restore to Recommended</button>}
          {hasAction("restore") && <button disabled={busyAction !== null} onClick={() => setConfirm("restore")}>Restore</button>}
          {hasAction("generate") && <button disabled={!canStartSampleRun(runActive, Boolean(runStarting)) || busyAction !== null} onClick={() => void startGeneration("generate")}>{runStarting === "generate" ? "Generating…" : runActive ? "Run active" : "Generate documents"}</button>}
          {hasAction("regenerate") && <button disabled={!canStartSampleRun(runActive, Boolean(runStarting)) || busyAction !== null} onClick={() => void startGeneration("regenerate")}>{runStarting === "regenerate" ? "Regenerating…" : runActive ? "Run active" : "Regenerate"}</button>}
          {hasAction("approve") && <button disabled={!verified || busyAction !== null} onClick={() => setConfirm("approval")}>{verified ? "Approve documents" : "Verify before approval"}</button>}
          {hasAction("apply") && <button disabled={busyAction !== null} onClick={() => setApplyOpen(true)}>Mark Applied</button>}
          {hasAction("phrase") && <button disabled={busyAction !== null} onClick={() => navigate(trackerHref("phrase", job.id))}>Open PHRASE</button>}
          {hasAction("outcome") && <button disabled={busyAction !== null} onClick={() => setOutcomeOpen(true)}>Change outcome</button>}
          {hasAction("archive") && <button disabled={busyAction !== null} onClick={() => setConfirm("archive")}>Archive</button>}
        </div>
        {busyAction && <p className="sample-busy">Updating record…</p>}
      </div>
      <section className="sample-section sample-documents">
        <div className="sample-section-head"><h2>DOCUMENTS</h2><span>{documentStatus(job)}</span></div>
        <div className="sample-document-summary">
          <div><span>CV</span><b>{job.cv_source ? (job.cv_pdf ? "PDF + source" : "Source only") : "Not generated"}</b></div>
          <div><span>LETTER</span><b>{job.cover_letter_source ? (job.cover_letter_pdf ? "PDF + source" : "Source only") : "Not generated"}</b></div>
          <div><span>APPROVAL</span><b>{job.approved_at ? formatDate(job.approved_at) : verified ? "Awaiting review" : "Not approved"}</b></div>
        </div>
        <div className="sel-actions sample-links">
          {job.cv_pdf && <a href={`/api/files/${job.id}/cv.pdf`} target="_blank" rel="noreferrer">Open CV PDF ↗</a>}
          {job.cover_letter_pdf && <a href={`/api/files/${job.id}/cover-letter.pdf`} target="_blank" rel="noreferrer">Open letter PDF ↗</a>}
          {job.cv_source && <a href={`/api/files/${job.id}/cv.tex`} target="_blank" rel="noreferrer">Open CV source ↗</a>}
          {job.cover_letter_source && <a href={`/api/files/${job.id}/cover-letter.tex`} target="_blank" rel="noreferrer">Open letter source ↗</a>}
          {!job.cv_source && !job.cover_letter_source && <span className="sample-muted">No generated files.</span>}
        </div>
      </section>
      </div>
    </aside>

    <ConfirmDialog open={confirm === "archive"} title="Archive this job?" onClose={() => setConfirm(null)} onConfirm={() => { setConfirm(null); void act(`/api/jobs/${job.id}/archive`, "POST", undefined, "Job archived."); }}>The job stays in the database and can be restored. No files are deleted.</ConfirmDialog>
    <ConfirmDialog open={confirm === "restore-recommended"} title="Restore to Recommended?" onClose={() => setConfirm(null)} onConfirm={() => { setConfirm(null); void act(`/api/jobs/${job.id}/restore-recommended`, "POST", undefined, "Job restored to Recommended."); }}>This returns the discarded job to the manual recommendation queue.</ConfirmDialog>
    <ConfirmDialog open={confirm === "restore"} title="Restore this job?" onClose={() => setConfirm(null)} onConfirm={() => { setConfirm(null); void act(`/api/jobs/${job.id}/restore`, "POST", undefined, "Job restored."); }}>This restores the archived job to its previous active stage. No files are deleted.</ConfirmDialog>
    <ConfirmDialog open={confirm === "approval"} title="Approve documents?" onClose={() => setConfirm(null)} onConfirm={() => { setConfirm(null); if (!canApproveSampleDocuments(job.verification)) { toast("Successful verification is required before approval."); return; } void act(`/api/jobs/${job.id}/approve`, "POST", undefined, "Documents approved."); }}>I reviewed both the CV and cover letter. Verification alone does not approve them; this confirmation moves the job to Ready.</ConfirmDialog>
    <ApplyDialog open={applyOpen} initialDate={job.submitted_at} initialChannel={job.submission_channel} initialNotes={applicationNotes} onClose={() => setApplyOpen(false)} onConfirm={(value) => { setApplyOpen(false); void act(`/api/jobs/${job.id}/applied`, "POST", value, "Application marked Applied."); }} />
    <OutcomeDialog open={outcomeOpen} initialNotes={applicationNotes} onClose={() => setOutcomeOpen(false)} onConfirm={(value) => { setOutcomeOpen(false); void act(`/api/jobs/${job.id}/outcome`, "POST", value, "Outcome updated."); }} />
  </>;
}

function SampleDialog({ open, title, children, actions, onClose }: { open: boolean; title: string; children: ReactNode; actions: ReactNode; onClose: () => void }) {
  if (!open) return null;
  return <div className="sample-dialog-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <div className="sample-dialog" role="dialog" aria-modal="true" aria-labelledby="sample-dialog-title">
      <div className="sample-dialog-head"><h2 id="sample-dialog-title">{title}</h2><button aria-label="Close dialog" onClick={onClose}>×</button></div>
      <div className="sample-dialog-body">{children}</div>
      <div className="sample-dialog-actions">{actions}</div>
    </div>
  </div>;
}

function ConfirmDialog({ open, title, children, onClose, onConfirm }: { open: boolean; title: string; children: ReactNode; onClose: () => void; onConfirm: () => void }) {
  return <SampleDialog open={open} title={title} onClose={onClose} actions={<><button onClick={onClose}>Cancel</button><button className="sample-confirm" onClick={onConfirm}>Confirm</button></>}><p>{children}</p></SampleDialog>;
}

function ApplyDialog({ open, initialDate, initialChannel, initialNotes, onClose, onConfirm }: { open: boolean; initialDate?: string | null; initialChannel?: string | null; initialNotes: string; onClose: () => void; onConfirm: (value: { submittedAt: string; channel: string; notes: string }) => void }) {
  const [submittedAt, setSubmittedAt] = useState(() => initialDate ?? new Date().toISOString().slice(0, 10));
  const [channel, setChannel] = useState(initialChannel ?? "");
  const [notes, setNotes] = useState(initialNotes);
  useEffect(() => {
    if (!open) return;
    setSubmittedAt(initialDate ?? new Date().toISOString().slice(0, 10));
    setChannel(initialChannel ?? "");
    setNotes(initialNotes);
  }, [initialChannel, initialDate, initialNotes, open]);
  return <SampleDialog open={open} title="Mark as Applied" onClose={onClose} actions={<><button onClick={onClose}>Cancel</button><button className="sample-confirm" disabled={!submittedAt} onClick={() => onConfirm({ submittedAt, channel, notes })}>Confirm Applied</button></>}>
    <p className="sample-dialog-copy">This records an application you already submitted outside the dashboard. It does not submit anything for you.</p>
    <label className="field">Submission date<input type="date" value={submittedAt} onChange={(event) => setSubmittedAt(event.target.value)} required /></label>
    <label className="field">Channel or portal<input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="Company careers portal" /></label>
    <label className="field">Notes<textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
  </SampleDialog>;
}

function OutcomeDialog({ open, initialNotes, onClose, onConfirm }: { open: boolean; initialNotes: string; onClose: () => void; onConfirm: (value: { stage: "Interview" | "Offer" | "Rejected"; notes: string }) => void }) {
  const [stage, setStage] = useState<"Interview" | "Offer" | "Rejected">("Interview");
  const [notes, setNotes] = useState(initialNotes);
  useEffect(() => { if (open) { setStage("Interview"); setNotes(initialNotes); } }, [initialNotes, open]);
  return <SampleDialog open={open} title="Change outcome" onClose={onClose} actions={<><button onClick={onClose}>Cancel</button><button className="sample-confirm" onClick={() => onConfirm({ stage, notes })}>Save outcome</button></>}>
    <label className="field">Outcome<select value={stage} onChange={(event) => setStage(event.target.value as typeof stage)}><option>Interview</option><option>Offer</option><option>Rejected</option></select></label>
    <label className="field">Outcome notes<textarea rows={5} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
  </SampleDialog>;
}
