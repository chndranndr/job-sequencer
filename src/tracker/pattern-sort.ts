import type { CustomJobSource, Job } from "../shared.js";
import { jobSourceLabel } from "../shared.js";
import { inboxAgeDays, scoreToSignal } from "./notes.js";

export type PatternSortKey = "sample" | "sig" | "fit" | "age" | "fx" | "src";
export type PatternSortDirection = "ascending" | "descending";

function compareText(left: string, right: string) {
  const a = left.toLocaleLowerCase();
  const b = right.toLocaleLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumbers(left: number, right: number, direction: PatternSortDirection) {
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (!leftValid || !rightValid) return leftValid === rightValid ? 0 : leftValid ? -1 : 1;
  return direction === "ascending" ? left - right : right - left;
}

function compareTextValues(left: readonly string[], right: readonly string[], direction: PatternSortDirection) {
  for (let index = 0; index < left.length; index++) {
    const result = compareText(left[index] ?? "", right[index] ?? "");
    if (result) return direction === "ascending" ? result : -result;
  }
  return 0;
}

export function sortPatternJobs(
  jobs: Job[],
  key: PatternSortKey | null,
  direction: PatternSortDirection,
  now: number,
  customSources: readonly CustomJobSource[] = [],
) {
  if (!key) return jobs.slice();
  return jobs
    .map((job, index) => ({ job, index }))
    .sort((left, right) => {
      const a = left.job;
      const b = right.job;
      let result = 0;
      if (key === "fit") result = compareNumbers(a.score, b.score, direction);
      else if (key === "age") result = compareNumbers(inboxAgeDays(a.first_seen_at, now), inboxAgeDays(b.first_seen_at, now), direction);
      else if (key === "sample") result = compareTextValues([a.company, a.role, a.location], [b.company, b.role, b.location], direction);
      else if (key === "sig") result = compareTextValues([scoreToSignal(a)], [scoreToSignal(b)], direction);
      else if (key === "fx") result = compareTextValues([a.stage.toUpperCase()], [b.stage.toUpperCase()], direction);
      else result = compareTextValues([jobSourceLabel(a.source, customSources)], [jobSourceLabel(b.source, customSources)], direction);
      return result || left.index - right.index;
    })
    .map(({ job }) => job);
}
