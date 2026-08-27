import { useState } from "react";
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
  jobs, settings, filter, onFilter, playIndex, running, now, navigate, ...agent
}: {
  jobs: Job[];
  settings: Settings | null;
  filter: JobStage | "all";
  onFilter: (stage: JobStage | "all") => void;
  playIndex: number;
  running: boolean;
  navigate: (href: string) => void;
} & Omit<Parameters<typeof AgentPane>[0], "jobs" | "navigate" | "onFilter">) {
  const [sortKey, setSortKey] = useState<PatternSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<PatternSortDirection>("ascending");
  const visible = jobs.filter((job) => filter === "all" || job.stage === filter);
  const sorted = sortPatternJobs(visible, sortKey, sortDirection, now, settings?.customSources ?? []);
  const empty = patternEmptyCopy(filter, jobs.length);
  const ranked = jobs.filter((job) => job.stage === "Recommended").length;

  function toggleSort(key: PatternSortKey) {
    if (sortKey === key) setSortDirection((value) => value === "ascending" ? "descending" : "ascending");
    else { setSortKey(key); setSortDirection("ascending"); }
  }

  return <>
    <section className="panel">
      <div className="panel-h">PATTERN 00 <span>{visible.length} notes</span></div>
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
  </>;
}
