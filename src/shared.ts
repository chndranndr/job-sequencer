export type JobStage =
  | "Recommended"
  | "Discarded"
  | "Selected"
  | "Drafting"
  | "Ready"
  | "Applied"
  | "Interview"
  | "Offer"
  | "Rejected"
  | "Archived";

export const jobStages: JobStage[] = [
  "Recommended",
  "Discarded",
  "Selected",
  "Drafting",
  "Ready",
  "Applied",
  "Interview",
  "Offer",
  "Rejected",
  "Archived",
];

export const applicationStages: JobStage[] = [
  "Selected",
  "Drafting",
  "Ready",
  "Applied",
  "Interview",
  "Offer",
  "Rejected",
];

export const applicationLanes = ["Selected", "Drafting", "Ready", "Applied", "Interview", "Outcomes"] as const;
export type ApplicationLane = (typeof applicationLanes)[number];

export const defaultJobStages: JobStage[] = ["Recommended", "Selected", "Drafting", "Ready", "Applied", "Interview", "Offer"];

export const jobSourceKeys = ["freehire", "linkedin", "tokyodev", "japan-dev"] as const;
export type BuiltInJobSource = (typeof jobSourceKeys)[number];
export type JobSource = BuiltInJobSource | (string & {});
export const jobSourceLabels: Record<BuiltInJobSource, string> = {
  freehire: "FreeHire",
  linkedin: "LinkedIn",
  tokyodev: "TokyoDev",
  "japan-dev": "Japan Dev",
};

export type SourceMaxAgeDays = Record<BuiltInJobSource, number>;
export const defaultSourceMaxAgeDays: SourceMaxAgeDays = { freehire: 9999, linkedin: 9999, tokyodev: 45, "japan-dev": 45 };

export function isJobSource(value: unknown): value is BuiltInJobSource {
  return typeof value === "string" && (jobSourceKeys as readonly string[]).includes(value);
}

export type SearchHit = {
  source: JobSource;
  sourceId: string;
  url: string;
  title: string;
  company?: string;
  location?: string;
  postedAt?: string;
};

export type CustomJsonParser = {
  format: "json";
  search: {
    resultsPath: string;
    fields: { id: string; title: string; url: string; company?: string; location?: string };
  };
  detail: { fields: { id: string; title: string; url: string; description: string } };
};

export type CustomHtmlField = { selector: string; attribute?: string };
export type CustomHtmlParser = {
  format: "html";
  search: {
    itemSelector: string;
    fields: { id: CustomHtmlField; title: CustomHtmlField; url: CustomHtmlField; company?: CustomHtmlField; location?: CustomHtmlField };
  };
  detail: { fields: { id: CustomHtmlField; title: CustomHtmlField; url: CustomHtmlField; description: CustomHtmlField } };
};

export type CustomSourceParser = CustomJsonParser | CustomHtmlParser;
export type CustomJobSource = {
  key: string;
  label: string;
  searchUrlTemplate: string;
  detailUrlTemplate: string;
  parser: CustomSourceParser;
};

export function jobSourceLabel(source: string, customSources: readonly CustomJobSource[] = []): string {
  if (source === "manual") return "Manual";
  if (isJobSource(source)) return jobSourceLabels[source];
  return customSources.find((item) => item.key === source)?.label ?? source;
}

export type Criteria = {
  roles: string[];
  locations: string[];
  remoteOnly: boolean;
  keywords: string[];
  excludeKeywords: string[];
  employmentTypes: string[];
  maxJobsPerRun: number;
};

export type SearchGoal = {
  criteria: Criteria;
  enabledSources: JobSource[];
};

export type SearchBudget = Readonly<{
  maxSearchCalls: number;
  maxDetailCalls: number;
  maxTotalResults: number;
  maxRunDurationMs: number;
}>;

export type Settings = {
  provider: string;
  model: string;
  /** Legacy compatibility alias. Use enabledSources for new settings. */
  source: BuiltInJobSource;
  enabledSources?: string[];
  customSources?: CustomJobSource[];
  sourceMaxAgeDays?: SourceMaxAgeDays;
  scoreThreshold: number;
  maxResults: number;
  cvPages: number;
  coverLetterPages: number;
};

export type ProfileEntry = { id: string };

export type ExperienceEntry = ProfileEntry & {
  title: string;
  company: string;
  employmentType: string;
  location: string;
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  currentRole: boolean;
  description: string;
};

export type EducationEntry = ProfileEntry & {
  institution: string;
  degree: string;
  fieldOfStudy: string;
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  gpa: string;
};

export type SkillEntry = ProfileEntry & { name: string };

export type CertificationEntry = ProfileEntry & {
  name: string;
  issuer: string;
  issueDate: string;
  expiryDate: string;
  url: string;
  description: string;
};

export type ProjectEntry = ProfileEntry & {
  name: string;
  role: string;
  description: string;
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  url: string;
};

export type AwardEntry = ProfileEntry & {
  title: string;
  issuer: string;
  date: string;
  description: string;
};

export type LanguageEntry = ProfileEntry & { name: string; proficiency: string };

export type StructuredProfile = {
  version: 1;
  identity: {
    firstName: string;
    lastName: string;
    headline: string;
    email: string;
    phone: string;
    city: string;
    country: string;
    website: string;
    linkedinUrl: string;
    githubUrl: string;
    summary: string;
  };
  workPreferences: {
    authorizationStatus: string;
    relocationPreference: string;
    remotePreference: string;
    targetRoles: string[];
    dealBreakers: string[];
  };
  experience: ExperienceEntry[];
  education: EducationEntry[];
  skills: SkillEntry[];
  certifications: CertificationEntry[];
  projects: ProjectEntry[];
  awards: AwardEntry[];
  languages: LanguageEntry[];
};

export type {
  AgentCandidateContext,
  ApplicationStrategy,
  AtsIssue,
  AtsIssueKind,
  AtsReview,
  CVDocument,
  EvidenceBank,
  EvidenceItem,
  EvidenceRef,
  StrategyRequirement,
} from "./server/agents/types.js";

export type LegacyProfile = { available: boolean; content: string | null };

export type Rank = { reason: string; strengths: string[]; gaps: string[] };

export type DocumentVerification = {
  success: boolean;
  cvPages: number;
  coverLetterPages: number;
  cvTextPresent: boolean;
  coverLetterTextPresent: boolean;
  emailPresent: boolean;
  phonePresent: boolean;
  checkedAt: string;
  ats?: AtsChecks;
};

export type AtsChecks = {
  emailPresent: boolean;
  phonePresent: boolean;
  employersPresent: boolean;
  datesPresent: boolean;
  glyphError: boolean;
  replacementCharacter: boolean;
  duplicateBullets: boolean;
  issues: string[];
};

export type GenerationDirection = {
  cvLength: "short" | "complete";
  cvPagesOverride: number | null;
  letterMode: "standard" | "exploratory";
  letterNarration: string;
  revisionNotes: string;
  revisionCount: number;
};

export const defaultGenerationDirection: GenerationDirection = {
  cvLength: "complete",
  cvPagesOverride: null,
  letterMode: "standard",
  letterNarration: "",
  revisionNotes: "",
  revisionCount: 0,
};

export function effectiveCvPages(settings: Pick<Settings, "cvPages">, direction: Pick<GenerationDirection, "cvPagesOverride">) {
  return direction.cvPagesOverride ?? settings.cvPages;
}

export type Job = {
  id: string;
  source_id: string;
  source: string;
  url: string;
  company: string;
  role: string;
  location: string;
  posting: string;
  score: number;
  stage: JobStage;
  rank: Rank;
  notes: string;
  first_seen_at: string;
  updated_at: string;
  archived_from_stage?: JobStage | null;
  cv_template?: string | null;
  cv_source?: string | null;
  cv_pdf?: string | null;
  cover_letter_source?: string | null;
  cover_letter_pdf?: string | null;
  verification?: DocumentVerification | null;
  approved_at?: string | null;
  submitted_at?: string | null;
  submission_channel?: string | null;
  application_notes?: string | null;
  interview_notes?: string | null;
  interview_messages?: InterviewMessage[];
  interview_updated_at?: string | null;
  follow_up_draft?: string | null;
  follow_up_due_at?: string | null;
  follow_up_sent_at?: string | null;
  follow_up_context?: FollowUpContext | null;
  generation_direction?: GenerationDirection;
  outcome?: string | null;
};

export type InterviewMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type FollowUpContext = {
  purpose: string;
  recipient: string;
  context: string;
  tone: string;
};

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type RunWorkflow = "scrape" | "generate" | "interview" | "follow_up" | "manual_import" | "profile_import" | "test";

export type TrajectoryEventKind = "system" | "user" | "assistant" | "thinking" | "tool_call" | "tool_update" | "tool_result" | "lifecycle" | "error";

export type TrajectoryEventInput = {
  kind: TrajectoryEventKind;
  type: string;
  timestamp?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  payload?: unknown;
};

export type TrajectoryEvent = Required<Pick<TrajectoryEventInput, "kind" | "type">> & {
  runId: string;
  sequence: number;
  timestamp: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  payload: unknown;
};

export type TrajectoryRecorder = (runId: string, event: TrajectoryEventInput) => void;

export type TaskEventStatus = "started" | "completed" | "failed";

export type TaskEventPayload = {
  taskId: string;
  label: string;
  detail?: string;
  status: TaskEventStatus;
  attempt?: number;
};

export type RunTaskRowStatus = "completed" | "active" | "pending" | "failed";

export type RunTaskRow = {
  taskId: string;
  label: string;
  detail?: string;
  status: RunTaskRowStatus;
  attempt?: number;
};

function taskPayload(event: TrajectoryEvent): TaskEventPayload | null {
  if (event.kind !== "lifecycle" || !event.type.startsWith("task_")) return null;
  const status = event.type.slice("task_".length);
  if (status !== "started" && status !== "completed" && status !== "failed") return null;
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  if (payload.status !== status || typeof payload.taskId !== "string" || typeof payload.label !== "string") return null;
  return {
    taskId: payload.taskId,
    label: payload.label,
    detail: typeof payload.detail === "string" && payload.detail ? payload.detail : undefined,
    status,
    attempt: typeof payload.attempt === "number" && Number.isInteger(payload.attempt) ? payload.attempt : undefined,
  };
}

const fallbackTaskPlan: Record<RunWorkflow, Array<[string, string]>> = {
  scrape: [
    ["scrape:fallback:prepare", "Prepare scrape context"],
    ["scrape:fallback:search", "Search enabled sources"],
    ["scrape:fallback:inspect", "Fetch and inspect job details"],
    ["scrape:fallback:validate", "Validate and score results"],
    ["scrape:fallback:persist", "Persist jobs and finalize"],
  ],
  generate: [
    ["generate:fallback:prepare", "Prepare selected jobs"],
    ["generate:fallback:research", "Research company context"],
    ["generate:fallback:strategy", "Plan tailored content"],
    ["generate:fallback:writer", "Write tailored content"],
    ["generate:fallback:claims", "Validate claims"],
    ["generate:fallback:audit", "Audit factual claims"],
    ["generate:fallback:critic", "Critique document quality"],
    ["generate:fallback:revise", "Revise document"],
    ["generate:fallback:ats", "Review ATS coverage"],
    ["generate:fallback:ats-revise", "Revise ATS coverage"],
    ["generate:fallback:documents", "Compile and verify documents"],
    ["generate:fallback:finalize", "Finalize each job"],
  ],
  interview: [
    ["interview:fallback:prepare", "Prepare interview context"],
    ["interview:fallback:response", "Generate interviewer response"],
    ["interview:fallback:save", "Save response"],
  ],
  follow_up: [
    ["follow_up:fallback:prepare", "Prepare follow-up context"],
    ["follow_up:fallback:draft", "Draft follow-up message"],
    ["follow_up:fallback:save", "Save draft"],
  ],
  manual_import: [
    ["manual_import:fallback:prepare", "Prepare manual import"],
    ["manual_import:fallback:parse-score", "Fetch or parse and score job"],
    ["manual_import:fallback:persist", "Persist scored job"],
  ],
  profile_import: [
    ["profile_import:fallback:extract", "Read resume document"],
    ["profile_import:fallback:map", "Map fields with Pi"],
    ["profile_import:fallback:merge", "Merge into profile bank"],
  ],
  test: [["test:fallback:provider", "Test provider connection"]],
};

function fallbackTaskRows(workflow: RunWorkflow, status: RunStatus): RunTaskRow[] {
  const plan = fallbackTaskPlan[workflow];
  const terminalDetail = status === "cancelled" ? "Run cancelled." : status === "timed_out" ? "Run timed out." : "Run failed.";
  return plan.map(([taskId, label], index) => ({
    taskId,
    label,
    status: status === "queued" ? "pending" : status === "running" ? (index === 0 ? "active" : "pending") : status === "succeeded" ? "completed" : index === 0 ? "failed" : "pending",
    detail: status !== "running" && status !== "succeeded" && index === 0 ? terminalDetail : undefined,
  }));
}

export function deriveRunTaskRows(events: readonly TrajectoryEvent[], workflow: RunWorkflow, runStatus: RunStatus): RunTaskRow[] {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.sequence - right.event.sequence || left.index - right.index);
  const rows = new Map<string, RunTaskRow>();
  for (const { event } of ordered) {
    const task = taskPayload(event);
    if (!task) continue;
    const row = rows.get(task.taskId) ?? { taskId: task.taskId, label: task.label, status: "pending" as const };
    row.label = task.label;
    if (task.detail !== undefined) row.detail = task.detail;
    if (task.attempt !== undefined) row.attempt = task.attempt;
    row.status = task.status === "started" ? "active" : task.status === "completed" ? "completed" : "failed";
    rows.set(task.taskId, row);
  }
  if (!rows.size) return fallbackTaskRows(workflow, runStatus);

  const result = [...rows.values()];
  if (runStatus !== "running" && runStatus !== "queued") {
    for (const row of result) {
      if (row.status !== "active") continue;
      row.status = runStatus === "succeeded" ? "completed" : "failed";
      row.detail ??= runStatus === "cancelled" ? "Run cancelled." : runStatus === "timed_out" ? "Run timed out." : "Run failed before this task completed.";
    }
    if (runStatus !== "succeeded" && !result.some((row) => row.status === "failed")) {
      result.push({ taskId: `${workflow}:terminal`, label: runStatus === "cancelled" ? "Cancel workflow" : "Finish workflow", detail: runStatus === "cancelled" ? "Run cancelled." : "Run failed before finalization.", status: "failed" });
    }
  }
  return result;
}

export type RunTrajectoryEnvelope = {
  runId: string;
  status: RunStatus;
  events: TrajectoryEvent[];
};

export type Run = {
  id: string;
  workflow: RunWorkflow;
  job_id?: string | null;
  status: RunStatus;
  provider: string;
  model: string;
  summary: unknown;
  idempotency_key?: string | null;
  error?: string | null;
  error_code?: string | null;
  attempt_count?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  estimated_cost?: number | null;
  prompt_hash?: string | null;
  guidance_hash?: string | null;
  settings_hash?: string | null;
  started_at: string;
  finished_at?: string | null;
};

export function createEmptyProfile(): StructuredProfile {
  return {
    version: 1,
    identity: {
      firstName: "",
      lastName: "",
      headline: "",
      email: "",
      phone: "",
      city: "",
      country: "",
      website: "",
      linkedinUrl: "",
      githubUrl: "",
      summary: "",
    },
    workPreferences: {
      authorizationStatus: "",
      relocationPreference: "",
      remotePreference: "",
      targetRoles: [],
      dealBreakers: [],
    },
    experience: [],
    education: [],
    skills: [],
    certifications: [],
    projects: [],
    awards: [],
    languages: [],
  };
}

export function stageForScore(score: number, threshold = 60): "Recommended" | "Discarded" {
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error("score must be an integer between 0 and 100");
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) throw new Error("threshold must be an integer between 0 and 100");
  return score > threshold ? "Recommended" : "Discarded";
}

const transitions: Record<JobStage, JobStage[]> = {
  Recommended: ["Selected", "Archived"],
  Discarded: ["Recommended", "Archived"],
  Selected: ["Recommended", "Drafting", "Archived"],
  Drafting: ["Ready", "Archived"],
  Ready: ["Drafting", "Applied", "Archived"],
  Applied: ["Interview", "Offer", "Rejected", "Archived"],
  Interview: ["Offer", "Rejected", "Archived"],
  Offer: ["Rejected", "Archived"],
  Rejected: ["Archived"],
  Archived: [],
};

export function canTransitionStage(from: JobStage, to: JobStage): boolean {
  return from === to || transitions[from].includes(to);
}

export function assertStageTransition(from: JobStage, to: JobStage): void {
  if (!canTransitionStage(from, to)) throw new Error(`Cannot change ${from} to ${to}.`);
}
