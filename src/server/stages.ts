import { jobStages as sharedJobStages, stageForScore, type JobStage } from "../shared.js";

export type { JobStage } from "../shared.js";
export const jobStages = sharedJobStages;
export const advancedStages: JobStage[] = ["Selected", "Drafting", "Ready", "Applied", "Interview", "Offer", "Rejected", "Archived"];
export { stageForScore };
