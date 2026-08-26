import { useCallback, useEffect, useMemo, useState } from "react";
import type { FollowUpContext, Job, Run } from "../shared.js";
import { api, getJob } from "../api.js";

const emptyContext: FollowUpContext = { purpose: "", recipient: "", context: "", tone: "Professional" };

export function isFollowUpEligible(job: Job | null | undefined) {
  return job?.stage === "Applied" || job?.stage === "Interview";
}

export type FollowUpActionState = {
  active: boolean;
  canDraft: boolean;
  canSave: boolean;
  canMarkSent: boolean;
};

export function followUpActionState({ job, run, draft, dirty }: { job: Job | null | undefined; run: Pick<Run, "workflow" | "status"> | null; draft: string; dirty: boolean }): FollowUpActionState {
  const eligible = isFollowUpEligible(job);
  const active = run?.status === "running";
  const hasDraft = Boolean(draft.trim());
  return {
    active,
    canDraft: Boolean(eligible) && !active,
    canSave: Boolean(eligible) && hasDraft && dirty && !active,
    canMarkSent: Boolean(eligible) && hasDraft && !dirty && !active,
  };
}

function savedDueDate(value?: string | null) {
  return value ? value.slice(0, 10) : "";
}

export function FollowUpView({ jobs, run, onRun, onReload, toast }: { jobs: Job[]; run: Run | null; onRun: (run: Pick<Run, "id" | "workflow" | "status">) => void; onReload: () => void; toast: (message: string) => void }) {
  const eligibleJobs = useMemo(() => jobs.filter(isFollowUpEligible), [jobs]);
  const [selectedId, setSelectedId] = useState(eligibleJobs[0]?.id ?? "");
  const [job, setJob] = useState<Job | null>(null);
  const [context, setContext] = useState<FollowUpContext>(emptyContext);
  const [dueAt, setDueAt] = useState("");
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (eligibleJobs.some((item) => item.id === selectedId)) return;
    setSelectedId(eligibleJobs[0]?.id ?? "");
  }, [eligibleJobs, selectedId]);

  const syncJob = useCallback((value: Job) => {
    setJob(value);
    setContext(value.follow_up_context ?? emptyContext);
    setDueAt(savedDueDate(value.follow_up_due_at));
    setDraft(value.follow_up_draft ?? "");
    setDirty(false);
    setConfirmSent(false);
  }, []);

  const load = useCallback(async () => {
    if (!selectedId) {
      setJob(null);
      return;
    }
    try {
      syncJob(await getJob(selectedId));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the follow-up job.");
    }
  }, [selectedId, syncJob]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (run?.workflow !== "follow_up" || run.status === "running") return;
    void load();
    if (run.status === "succeeded") toast("Follow-up draft ready to edit.");
    else toast(run.error ?? "Follow-up draft failed. Previous saved draft was kept.");
  }, [load, run?.error, run?.id, run?.status, run?.workflow, toast]);

  const actions = followUpActionState({ job, run, draft, dirty });
  const activeRun = run?.status === "running";
  const runLabel = activeRun ? run.workflow === "follow_up" ? "FOLLOW-UP DRAFTING ACTIVE" : `${run.workflow.toUpperCase()} ACTIVE` : run?.workflow === "follow_up" ? `LAST RUN · ${run.status.toUpperCase()}` : "IDLE · MANUAL FOLLOW-UP";

  function updateContext(key: keyof FollowUpContext, value: string) {
    setContext((current) => ({ ...current, [key]: value }));
  }

  async function draftFollowUp() {
    if (!job || !actions.canDraft || busy) return;
    setBusy(true);
    try {
      const result = await api<{ runId: string }>(`/api/jobs/${job.id}/follow-up`, { method: "POST", body: JSON.stringify({ context, dueAt }) });
      onRun({ id: result.runId, workflow: "follow_up", status: "running" });
      toast("Follow-up drafting started. The draft stays editable.");
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Follow-up drafting failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    if (!job || !actions.canSave || busy) return;
    setBusy(true);
    try {
      const value = await api<Job>(`/api/jobs/${job.id}/follow-up`, { method: "PATCH", body: JSON.stringify({ draft }) });
      syncJob(value);
      onReload();
      toast("Follow-up draft saved. It has not been sent.");
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Follow-up draft was not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function markSent() {
    if (!job || !actions.canMarkSent || busy) return;
    setConfirmSent(false);
    setBusy(true);
    try {
      const value = await api<Job>(`/api/jobs/${job.id}/follow-up/sent`, { method: "POST" });
      syncJob(value);
      onReload();
      toast("Marked sent. No email or message was sent by Tracker.");
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Could not mark the follow-up sent.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="order-followup" aria-label="Follow-up editor">
    <div className="follow-up__head"><div><strong>FOLLOW-UP EDITOR</strong><span>Applied / Interview only · draft outside Tracker, then mark the record</span></div><b className={activeRun ? "stage-o" : "stage-g"}>{runLabel}</b></div>
    {error && <div className="notice">{error}</div>}
    {!eligibleJobs.length ? <p className="empty">No Applied or Interview jobs yet. Mark a Ready job Applied before drafting a follow-up.</p> : <>
      <div className="follow-up__job"><label>JOB<select aria-label="Follow-up job" value={selectedId} disabled={activeRun || busy} onChange={(event) => setSelectedId(event.target.value)}>{eligibleJobs.map((item) => <option key={item.id} value={item.id}>{item.stage} · {item.company} · {item.role}</option>)}</select></label><span>{job?.submitted_at ? `Submitted ${savedDueDate(job.submitted_at)}` : "Application date not recorded"}</span></div>
      <div className="follow-up__fields">
        <label><span>PURPOSE</span><input value={context.purpose} onChange={(event) => updateContext("purpose", event.target.value)} placeholder="Thank the interviewer" /></label>
        <label><span>RECIPIENT</span><input value={context.recipient} onChange={(event) => updateContext("recipient", event.target.value)} placeholder="Hiring manager or interviewer" /></label>
        <label className="follow-up__context"><span>CONTEXT</span><textarea rows={3} value={context.context} onChange={(event) => updateContext("context", event.target.value)} placeholder="Interview date, topic, or application context" /></label>
        <label><span>TONE</span><select value={context.tone} onChange={(event) => updateContext("tone", event.target.value)}><option>Professional</option><option>Warm and concise</option><option>Direct</option></select></label>
        <label><span>DUE DATE · OPTIONAL</span><input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
      </div>
      <div className="follow-up__actions">
        <button type="button" disabled={!actions.canDraft || busy} onClick={() => void draftFollowUp()}>{activeRun && run?.workflow === "follow_up" ? "Drafting…" : "Draft follow-up"}</button>
        {draft && <button type="button" disabled={!actions.canSave || busy} onClick={() => void saveDraft()}>{dirty ? "Save edits" : "Saved"}</button>}
        {draft && <button type="button" disabled={!actions.canMarkSent || busy} onClick={() => setConfirmSent(true)}>Mark sent</button>}
      </div>
      {draft && <label className="follow-up__draft"><span>EDITABLE DRAFT · {dirty ? "UNSAVED" : "SAVED"}</span><textarea rows={8} value={draft} onChange={(event) => { setDraft(event.target.value); setDirty(true); }} /></label>}
      {draft && dirty && <p className="follow-up__hint">Save edits before marking sent. Tracker never sends email or messages.</p>}
      {confirmSent && <div className="follow-up__confirm" role="alertdialog" aria-label="Confirm mark sent"><p>Confirm mark sent for this saved draft? This records the status only; it will not send an email or message.</p><div><button type="button" onClick={() => setConfirmSent(false)}>Cancel</button><button type="button" onClick={() => void markSent()}>Confirm · mark sent</button></div></div>}
    </>}
  </section>;
}
