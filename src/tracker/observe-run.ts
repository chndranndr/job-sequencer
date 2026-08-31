import type { Run } from "../shared.js";

export async function coalesceObservedRun(options: {
  active: Run | null;
  currentId: string | null;
  load: (id: string) => Promise<Run>;
}): Promise<Run | null> {
  if (options.active) return options.active;
  if (!options.currentId) return null;
  return options.load(options.currentId);
}
