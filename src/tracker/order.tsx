import { useEffect, useMemo, useRef, useState } from "react";
import type { Job, JobStage, Run } from "../shared.js";
import { type OrderFocus, trackerHref } from "./hash.js";
import { rowHex, scoreToSignal } from "./notes.js";
import { FollowUpView } from "./follow-up.js";

const slots = [
  { key: "Selected", pos: "B00", pattern: "P-SEL", title: "SELECT", hint: "Gate · tunggu dokumen", focus: "draft" as const, gate: true },
  { key: "Drafting", pos: "B01", pattern: "P-DRF", title: "DRAFT", hint: "Pi · generate + verify", focus: "draft" as const, gate: false },
  { key: "Ready", pos: "B02", pattern: "P-RDY", title: "READY", hint: "Gate · submit manual", focus: "ready" as const, gate: true },
  { key: "Applied", pos: "B03", pattern: "P-APP", title: "APPLIED", hint: "Submitted", focus: "follow" as const, gate: false },
  { key: "Interview", pos: "B04", pattern: "P-INT", title: "PHRASE", hint: "Interview nyata", focus: "follow" as const, gate: false },
  { key: "Outcomes", pos: "B05", pattern: "P-OUT", title: "OUT", hint: "Offer / rejected / archived", focus: undefined, gate: false },
] as const;

const focusTitles: Record<OrderFocus, string> = {
  draft: "DOCS · posisi B00–B01",
  ready: "APPLY · posisi B02",
  follow: "FOLLOW · posisi B03–B04",
};

export function orderSlotJobs(jobs: readonly Job[], key: (typeof slots)[number]["key"]) {
  const rows = jobs.filter((job) => key === "Outcomes" ? job.stage === "Offer" || job.stage === "Rejected" || job.stage === "Archived" : job.stage === key);
  return rows.sort((left, right) => right.score - left.score);
}

export type OrderMetadata = {
  stage: JobStage;
  documents: string;
  approval: string;
  submitted: string;
  followUp: string;
  outcome: string;
};

export type OrderRowSummary = {
  stage: JobStage;
  fit: number;
  signal: string;
};

export function orderRowSummary(job: Job): OrderRowSummary {
  return { stage: job.stage, fit: job.score, signal: scoreToSignal(job) };
}

function orderDate(value?: string | null) {
  return value ? value.slice(0, 10) : "—";
}

export function orderMetadata(job: Job): OrderMetadata {
  const documents = job.verification?.success === true ? "VERIFIED" : job.verification?.success === false ? "FAILED" : job.cv_source || job.cover_letter_source ? "REVIEW" : "NONE";
  const approval = job.approved_at ? `APPROVED ${orderDate(job.approved_at)}` : job.verification?.success ? "AWAITING APPROVAL" : "—";
  const submitted = job.submitted_at ? `${orderDate(job.submitted_at)}${job.submission_channel ? ` · ${job.submission_channel}` : ""}` : "—";
  const followUp = job.follow_up_sent_at ? `SENT ${orderDate(job.follow_up_sent_at)}` : job.follow_up_draft ? job.follow_up_due_at ? `DUE ${orderDate(job.follow_up_due_at)}` : "DRAFT SAVED" : "—";
  const outcome = job.outcome || (job.stage === "Offer" || job.stage === "Rejected" ? job.stage : job.stage === "Archived" ? `ARCHIVED${job.archived_from_stage ? ` FROM ${job.archived_from_stage}` : ""}` : "—");
  return { stage: job.stage, documents, approval, submitted, followUp, outcome };
}

export function filterOrderJobs(jobs: readonly Job[], query: string, stage: JobStage | "all" = "all") {
  const needle = query.trim().toLowerCase();
  return jobs.filter((job) => {
    if (stage !== "all" && job.stage !== stage) return false;
    if (!needle) return true;
    return [job.company, job.role, job.location, job.source, ...Object.values(orderMetadata(job))].join(" ").toLowerCase().includes(needle);
  });
}

function rowFx(job: Job) {
  if (job.stage === "Drafting" && job.verification?.success === false) return "FAIL";
  if (job.stage === "Ready" && job.approved_at) return "OK";
  if (job.stage === "Applied" && job.submitted_at) return "SENT";
  if (job.stage === "Interview" && job.interview_updated_at) return "LIVE";
  if (job.stage === "Offer") return "WIN";
  if (job.stage === "Rejected") return "CUT";
  return "—";
}

function fxTone(job: Job) {
  const fx = rowFx(job);
  if (fx === "FAIL" || fx === "CUT") return "stage-m";
  if (fx === "OK" || fx === "WIN" || fx === "SENT" || fx === "LIVE") return "stage-g";
  if (fx === "—") return "stage-m";
  return "stage-o";
}

export function OrderView({ jobs, orderFocus, onGenerate, navigate, run, onRun, onReload, toast }: { jobs: Job[]; orderFocus: OrderFocus; onGenerate: (ids: string[]) => void; navigate: (href: string) => void; run: Run | null; onRun: (run: Pick<Run, "id" | "workflow" | "status">) => void; onReload: () => void; toast: (message: string) => void }) {
  const slotRefs = useRef<Record<string, HTMLElement | null>>({});
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<JobStage | "all">("all");
  useEffect(() => {
    const target = slots.find((slot) => slot.focus === orderFocus);
    if (!target) return;
    slotRefs.current[target.key]?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [orderFocus]);

  const visibleJobs = useMemo(() => filterOrderJobs(jobs, query, stage), [jobs, query, stage]);
  const selected = jobs.filter((job) => job.stage === "Selected");
  return <section className="panel order-panel">
    <div className="panel-h">
      ORDER LIST
      <span>{focusTitles[orderFocus]} · posisi = stage · klik baris untuk SAMPLE · follow-up editor</span>
    </div>
    <div className="order-controls" role="search" aria-label="Filter ORDER rows">
      <label><span>SEARCH</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Company, role, stage…" /></label>
      <label><span>STAGE</span><select value={stage} onChange={(event) => setStage(event.target.value as JobStage | "all")}><option value="all">ALL APPLICATIONS</option>{["Selected", "Drafting", "Ready", "Applied", "Interview", "Offer", "Rejected", "Archived"].map((value) => <option key={value}>{value}</option>)}</select></label>
      {(query || stage !== "all") && <button type="button" onClick={() => { setQuery(""); setStage("all"); }}>Clear</button>}
    </div>
    <div className="order-list" role="list" aria-label="Song order list">
      <div className="order-board">
      {slots.map((slot) => {
        const rows = orderSlotJobs(visibleJobs, slot.key);
        const focused = slot.focus === orderFocus;
        return <article className={`order-slot ${focused ? "focus" : ""} ${slot.gate ? "gate" : ""}`} key={slot.key} ref={(node) => { slotRefs.current[slot.key] = node; }}>
            <header className="order-slot__head">
              <div className="order-pos">{slot.pos}</div>
              <div className="order-slot__title">
                <h2>{slot.pattern} · {slot.title}</h2>
                <p>{slot.hint}</p>
              </div>
              <span className="order-count">{rows.length}</span>
            </header>
            <div className="order-slot__body">
              <table className="order-table">
                <thead><tr><th>ROW</th><th>APPLICATION</th><th>FX</th></tr></thead>
                <tbody>
                  {rows.length === 0 ? <tr><td colSpan={3} className="order-empty">{slot.key === "Outcomes" ? "No outcomes yet" : `No ${slot.key.toLowerCase()} rows`}</td></tr> : rows.map((job, index) => (
                    <OrderRow key={job.id} job={job} index={index} navigate={navigate} />
                  ))}
                </tbody>
              </table>
            </div>
          </article>;
      })}
      </div>
    </div>
    {orderFocus === "follow" && <FollowUpView jobs={jobs} run={run} onRun={onRun} onReload={onReload} toast={toast} />}
    {selected.length > 0 && <div className="reco">
      <h2>Jump ke P-DRF? Generate dokumen untuk pattern P-SEL.</h2>
      <p>{selected.map((job) => job.company).join(", ")}. Generate uses the direction stored on SAMPLE. Verifikasi tetap harus lulus. Approval tetap milik kamu.</p>
      <div className="choices">
        <button onClick={() => onGenerate(selected.map((job) => job.id))}>Accept · generate</button>
        <button onClick={() => navigate("#/pattern")}>Hold</button>
      </div>
    </div>}
  </section>;
}

function OrderRow({ job, index, navigate }: { job: Job; index: number; navigate: (href: string) => void }) {
  const summary = orderRowSummary(job);
  return <tr
    className={job.stage === "Drafting" && job.verification?.success === false ? "fail" : ""}
    onClick={() => navigate(trackerHref("sample", job.id))}
  >
    <td className="hex">{rowHex(index)}</td>
    <td><strong>{job.company}</strong><div className="order-role">{job.role}</div><dl className="order-meta">
      <div><dt>STAGE</dt><dd>{summary.stage}</dd></div>
      <div><dt>FIT</dt><dd>{summary.fit}</dd></div>
      <div><dt>SIGNAL</dt><dd>{summary.signal}</dd></div>
    </dl></td>
    <td className={fxTone(job)}>{rowFx(job)}</td>
  </tr>;
}
