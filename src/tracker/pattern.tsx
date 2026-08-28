import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Job, JobStage } from "../shared.js";
import { jobSourceLabel, type Settings } from "../shared.js";
import { AgentPane } from "./agent.js";
import { trackerHref } from "./hash.js";
import { inboxAgeDays, rowHex, scoreToSignal } from "./notes.js";
import { sortPatternJobs, type PatternSortDirection, type PatternSortKey } from "./pattern-sort.js";

const filters: Array<JobStage | "all"> = ["all", "Recommended", "Discarded", "Selected", "Drafting", "Ready", "Applied", "Interview"];
const sortableColumns: Array<{ key: PatternSortKey; label: string }> = [
  { key: "sample", label: "SAMPLE" },
  { key: "sig", label: "SIG" },
  { key: "fit", label: "FIT" },
  { key: "age", label: "AGE" },
  { key: "fx", label: "FX" },
  { key: "src", label: "SRC" },
];

function patternEmptyCopy(filter: JobStage | "all", total: number) {
  switch (filter) {
    case "all":
      return { title: "Pattern is empty", body: "Play scrape after DISK is ready. Ranked hits land here as notes." };
    case "Selected":
      return {
        title: "No armed rows",
        body: total
          ? "Selected only lists jobs you armed. Open a Recommended row, then Arm SELECT on SAMPLE."
          : "Nothing to arm yet. Scrape first, then pick rows from RANK.",
      };
    case "Recommended":
      return { title: "No ranked hits", body: "RANK fills after a scrape scores new postings." };
    case "Discarded":
      return { title: "No discarded notes", body: "Jobs below the fit threshold appear here after RANK." };
    case "Drafting":
      return { title: "No drafts", body: "Generate documents from Selected rows to fill this pattern." };
    case "Ready":
      return { title: "Nothing ready", body: "Approve drafted documents before they land here." };
    case "Applied":
      return { title: "Nothing applied", body: "Mark Applied on SAMPLE after you submit by hand." };
    case "Interview":
      return { title: "No interview rows", body: "Interview jobs appear here after you move them on SAMPLE." };
    default:
      return { title: "No notes in this pattern", body: "Clear the filter to see every row." };
  }
}

function stageTone(stage: JobStage) {
  if (stage === "Discarded" || stage === "Rejected" || stage === "Archived") return "stage-m";
  if (stage === "Applied" || stage === "Interview" || stage === "Offer" || stage === "Ready") return "stage-g";
  return "stage-o";
}

export function PatternView({
  jobs, settings, filter, onFilter, playIndex, running, now, navigate, onManualImport, ...agent
}: {
  jobs: Job[];
  settings: Settings | null;
  filter: JobStage | "all";
  onFilter: (stage: JobStage | "all") => void;
  playIndex: number;
  running: boolean;
  navigate: (href: string) => void;
  onManualImport: (input: string) => Promise<void>;
} & Omit<Parameters<typeof AgentPane>[0], "jobs" | "navigate" | "onFilter">) {
  const [sortKey, setSortKey] = useState<PatternSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<PatternSortDirection>("ascending");
  const [manualOpen, setManualOpen] = useState(false);
  const addJobButton = useRef<HTMLButtonElement>(null);
  const wasManualOpen = useRef(false);
  const visible = jobs.filter((job) => filter === "all" || job.stage === filter);
  const sorted = sortPatternJobs(visible, sortKey, sortDirection, now, settings?.customSources ?? []);
  const empty = patternEmptyCopy(filter, jobs.length);
  const ranked = jobs.filter((job) => job.stage === "Recommended").length;

  function toggleSort(key: PatternSortKey) {
    if (sortKey === key) setSortDirection((value) => value === "ascending" ? "descending" : "ascending");
    else { setSortKey(key); setSortDirection("ascending"); }
  }

  useEffect(() => {
    if (!manualOpen && wasManualOpen.current && !running) addJobButton.current?.focus();
    wasManualOpen.current = manualOpen;
  }, [manualOpen, running]);

  return <>
    <section className="panel">
      <div className="panel-h">
        <span className="panel-h-title">PATTERN 00 <span>{visible.length} notes</span></span>
        <button ref={addJobButton} type="button" className="panel-action" aria-haspopup="dialog" disabled={running} onClick={() => setManualOpen(true)}>ADD JOB</button>
      </div>
      <div className="filters" role="tablist">
        {filters.map((item) => <button key={item} className={`chip ${filter === item ? "on" : ""}`} onClick={() => onFilter(item)}>{item === "all" ? "All" : item}</button>)}
      </div>
      <div className="scroller">
        {visible.length === 0 ? <div className="empty empty--pattern">
          <strong>{empty.title}</strong>
          <p>{empty.body}</p>
          {filter !== "all" && jobs.length > 0 && (
            <button type="button" className="chip" onClick={() => onFilter(ranked ? "Recommended" : "all")}>
              {ranked ? `Show Recommended (${ranked})` : `Show all (${jobs.length})`}
            </button>
          )}
        </div> : <table className="tracker" aria-label="Job pattern: SIG keyword signal, FIT score, AGE inbox days, FX workflow stage, SRC job source">
          <thead><tr>
            <th scope="col">ROW</th>
            {sortableColumns.map(({ key, label }) => <th key={key} scope="col" aria-sort={sortKey === key ? sortDirection : "none"} className="sortable">
              <button type="button" title={`Sort ${label}`} onClick={() => toggleSort(key)}>{label}<span className="sort-indicator" aria-hidden="true">{sortKey === key ? (sortDirection === "ascending" ? "↑" : "↓") : ""}</span></button>
            </th>)}
          </tr></thead>
          <tbody>
            {sorted.map((job, index) => {
              const signal = scoreToSignal(job);
              const fitValue = Number.isFinite(job.score) ? String(job.score) : "—";
              const fitWidth = Number.isFinite(job.score) ? Math.max(0, Math.min(100, job.score)) : 0;
              const age = inboxAgeDays(job.first_seen_at, now);
              const source = jobSourceLabel(job.source, settings?.customSources ?? []);
              return <tr key={job.id} className={`${running && index === playIndex % visible.length ? "playhead" : ""} ${job.stage === "Selected" ? "sel" : ""}`} onClick={() => navigate(trackerHref("sample", job.id))}>
                <td className="hex">{rowHex(index)}</td>
                <td><strong>{job.company}</strong><div style={{ color: "var(--mute)" }}>{job.role} · {job.location || "Not specified"}</div></td>
                <td className="signal" title={signal === "FIT" ? "SIG: no fixed keyword matched" : `SIG: ${signal} keyword match`} aria-label={`SIG ${signal}`}>{signal}</td>
                <td className="fit" title={`FIT: ${fitValue} out of 100`} aria-label={`FIT score ${fitValue} out of 100`}>{fitValue} <span className="fit-spark" aria-hidden="true"><i style={{ width: `${fitWidth}%` }} /></span></td>
                <td className="age" title="AGE: days since this job first entered the inbox" aria-label={`AGE ${age} days`}>{age}d</td>
                <td className={stageTone(job.stage)} title={`FX: workflow stage ${job.stage}`} aria-label={`FX ${job.stage}`}>{job.stage.toUpperCase()}</td>
                <td className="hex" title={`SRC: ${source}`} aria-label={`SRC ${source}`}>{source}</td>
              </tr>;
            })}
          </tbody>
        </table>}
      </div>
    </section>
    <AgentPane {...agent} jobs={jobs} navigate={navigate} onFilter={onFilter} now={now} />
    <ManualAddDialog open={manualOpen} running={running} onClose={() => setManualOpen(false)} onManualImport={onManualImport} />
  </>;
}

function ManualAddDialog({ open, running, onClose, onManualImport }: { open: boolean; running: boolean; onClose: () => void; onManualImport: (input: string) => Promise<void> }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setInput("");
    setError("");
    inputRef.current?.focus();
  }, [open]);

  function close() {
    if (submitting) return;
    setInput("");
    setError("");
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || running) return;
    const value = input.trim();
    if (!value) {
      setError("Enter a posting URL or paste job text.");
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onManualImport(value);
      setInput("");
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manual import failed.");
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;
  return <div className="sample-dialog-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
    <form className="sample-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-add-dialog-title" aria-describedby="manual-add-dialog-copy" noValidate onSubmit={(event) => void submit(event)}>
      <div className="sample-dialog-head"><h2 id="manual-add-dialog-title">Add job manually</h2><button type="button" aria-label="Close add job dialog" disabled={submitting} onClick={close}>×</button></div>
      <div className="sample-dialog-body">
        <p id="manual-add-dialog-copy" className="sample-dialog-copy">Paste a full job posting or enter one HTTP(S) job URL. The reviewed profile and provider checks still apply.</p>
        <label className="field" htmlFor="manual-job-input">
          <span>Job URL or pasted posting</span>
          <textarea ref={inputRef} id="manual-job-input" aria-label="Job URL or pasted posting" aria-describedby={error ? "manual-add-dialog-copy manual-add-dialog-error" : "manual-add-dialog-copy"} aria-invalid={Boolean(error)} value={input} onChange={(event) => setInput(event.target.value)} placeholder="https://jobs.example.com/role or paste the posting" required rows={8} />
        </label>
        {error && <p id="manual-add-dialog-error" className="sample-dialog-error" role="alert">{error} Check the input and try again.</p>}
        {running && <p className="sample-dialog-copy">Another AI run is active. Wait for it to finish before adding a job.</p>}
      </div>
      <div className="sample-dialog-actions"><button type="button" disabled={submitting} onClick={close}>Cancel</button><button type="submit" className="sample-confirm" disabled={running || submitting}>{submitting ? "Adding job…" : running ? "Run active" : "Add job"}</button></div>
    </form>
  </div>;
}
