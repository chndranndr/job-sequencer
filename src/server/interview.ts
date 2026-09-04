import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type FollowUpContext, type InterviewMessage, type RunWorkflow, type TrajectoryRecorder } from "../shared.js";
import type { Settings } from "./config.js";
import { createRestrictedGenerationSession, PiRunCancelledError, PiRunTimeoutError, runBoundedPi, type PiRunUsage } from "./pi.js";
import { loadGuidance } from "./guidance.js";
import { projectPromptContext, trustedSection, untrustedSection } from "./context.js";
import { RunCoordinator } from "./coordinator.js";
import { InterviewSessionPool } from "./interview-sessions.js";

export const InterviewMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(20_000),
  createdAt: z.string().datetime(),
}).strict();

export const FollowUpContextSchema = z.object({
  purpose: z.string().max(300),
  recipient: z.string().max(300),
  context: z.string().max(20_000),
  tone: z.string().max(200),
}).strict();

export const InterviewRequestSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  focus: z.string().max(500).default(""),
}).strict();

export type InterviewDocumentContext = {
  cv: string | null;
  coverLetter: string | null;
};

export type InterviewExecutor = (context: {
  profile: string;
  job: Record<string, unknown>;
  documents: InterviewDocumentContext;
  messages: InterviewMessage[];
  focus: string;
  message: string;
  settings: Settings;
  signal: AbortSignal;
  runId?: string;
  trajectory?: TrajectoryRecorder;
  onDelta?: (fullText: string) => void;
  onUsage?: (usage: PiRunUsage) => void;
}) => Promise<string>;

export type FollowUpExecutor = (context: {
  profile: string;
  job: Record<string, unknown>;
  interviewNotes: string;
  followUp: FollowUpContext;
  settings: Settings;
  signal: AbortSignal;
  runId?: string;
  trajectory?: TrajectoryRecorder;
  onUsage?: (usage: PiRunUsage) => void;
}) => Promise<string>;

async function runTextSession(prompt: string, settings: Settings, signal: AbortSignal, systemPrompt: string, runId?: string, trajectory?: TrajectoryRecorder, onDelta?: (fullText: string) => void, onUsage?: (usage: PiRunUsage) => void) {
  let text = "";
  await runBoundedPi({
    prompt,
    timeoutMs: 120_000,
    signal,
    createSession: () => createRestrictedGenerationSession(settings, systemPrompt),
    runId,
    trajectory,
    onUsage,
    onEvent: (event) => {
      const value = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
      if (value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta") {
        text += value.assistantMessageEvent.delta ?? "";
        try { onDelta?.(text); } catch { /* streaming is deliberately non-fatal */ }
      }
    },
    onAssistantText: value => { text = value; },
  });
  if (!text.trim()) throw new Error("Provider returned an empty response.");
  return text.trim();
}

// ponytail: fallback history remains 40 messages; replace with token-aware compaction after context-pressure evidence.
const maxInterviewHistory = 40;

export function boundedInterviewHistory(messages: readonly InterviewMessage[]) {
  return messages.slice(-maxInterviewHistory);
}

function stableInterviewJob(job: Record<string, unknown>) {
  const changingApplicationFields = new Set([
    "interview_messages",
    "interview_notes",
    "application_notes",
    "follow_up_draft",
    "follow_up_context",
    "outcome",
  ]);
  return Object.fromEntries(Object.entries(job).filter(([key]) => !changingApplicationFields.has(key) && !key.endsWith("_at")));
}

async function interviewSystemPrompt(context: Parameters<InterviewExecutor>[0]) {
  return [
    trustedSection("SYSTEM", "You are a bounded mock interviewer. Do not invent candidate facts or job requirements."),
    trustedSection("INSTRUCTIONS", "Act as a concise, truthful interviewer. Ask one question at a time, respond to the latest answer with short feedback, and use only the supplied context."),
    trustedSection("INTERVIEW GUIDANCE", await loadGuidance(["interviewPrep"])),
    trustedSection("CANDIDATE PROFILE", context.profile),
    untrustedSection("JOB METADATA", JSON.stringify(projectPromptContext(Object.fromEntries(Object.entries(stableInterviewJob(context.job)).filter(([key]) => key !== "posting")))) ?? "null"),
    untrustedSection("JOB POSTING", String(context.job.posting ?? "")),
    untrustedSection("GENERATED DOCUMENTS", JSON.stringify(projectPromptContext(context.documents))),
  ].join("\n");
}

function interviewTurnPrompt(context: Parameters<InterviewExecutor>[0]) {
  return [
    untrustedSection("FOCUS", context.focus || "(none)"),
    untrustedSection("LATEST USER ANSWER", context.message),
  ].join("\n");
}

function interviewRebuildPrompt(context: Parameters<InterviewExecutor>[0]) {
  return [
    untrustedSection("PRIOR MESSAGES", JSON.stringify(projectPromptContext(boundedInterviewHistory(context.messages))) ?? "[]"),
    interviewTurnPrompt(context),
  ].join("\n");
}

function interviewJobId(context: Parameters<InterviewExecutor>[0]) {
  const jobId = context.job.id;
  if (typeof jobId !== "string" || !jobId) throw new Error("Interview context is missing a job ID.");
  return jobId;
}

export function createLiveInterviewExecutor(pool: InterviewSessionPool): InterviewExecutor {
  return async (context) => pool.run({
    jobId: interviewJobId(context),
    systemPrompt: await interviewSystemPrompt(context),
    prompt: interviewTurnPrompt(context),
    rebuildPrompt: interviewRebuildPrompt(context),
    settings: context.settings,
    signal: context.signal,
    runId: context.runId,
    trajectory: context.trajectory,
    onDelta: context.onDelta,
    onUsage: context.onUsage,
  });
}

// Kept for callers that still import the one-shot executor; buildServer uses the pooled factory.
export const liveInterviewExecutor: InterviewExecutor = async (context) => runTextSession(
  [await interviewSystemPrompt(context), interviewRebuildPrompt(context)].join("\n"),
  context.settings,
  context.signal,
  "You are a bounded mock interviewer. Do not invent candidate facts or job requirements.",
  context.runId,
  context.trajectory,
  context.onDelta,
  context.onUsage,
);

export const liveFollowUpExecutor: FollowUpExecutor = async (context) => runTextSession(
  [
    trustedSection("INSTRUCTIONS", "Draft one editable professional follow-up message. Return only the message body."),
    trustedSection("WRITING GUIDANCE", await loadGuidance(["writingStyle", "coverLetterTemplates"])),
    trustedSection("CANDIDATE PROFILE", context.profile),
    untrustedSection("JOB METADATA", JSON.stringify(projectPromptContext(context.job))),
    untrustedSection("INTERVIEW NOTES", context.interviewNotes),
    untrustedSection("FOLLOW-UP REQUEST", JSON.stringify(projectPromptContext(context.followUp))),
  ].join("\n"),
  context.settings,
  context.signal,
  "You draft a truthful follow-up from the supplied profile and application context only.",
  context.runId,
  context.trajectory,
  undefined,
  context.onUsage,
);

export type TaskRunExecutor = (context: { jobId: string; payload: unknown; profile: string; settings: Settings; signal: AbortSignal; runId?: string; trajectory?: TrajectoryRecorder; onUsage?: (usage: PiRunUsage) => void }) => Promise<unknown>;

/** One compact run wrapper for the two user-triggered text workflows. */
export class TaskRunManager {
  private readonly coordinator: RunCoordinator;

  constructor(private readonly options: {
    db: DatabaseSync;
    workflow: Extract<RunWorkflow, "interview" | "follow_up">;
    load: () => Promise<{ profile: string; settings: Settings }>;
    execute: TaskRunExecutor;
    trajectory?: TrajectoryRecorder;
    coordinator?: RunCoordinator;
  }) {
    this.coordinator = options.coordinator ?? new RunCoordinator({ db: options.db, trajectory: options.trajectory });
  }

  isActive() { return this.coordinator.isWorkflowActive(this.options.workflow); }

  async start(jobId: string, payload: unknown, idempotencyKey?: string) {
    const context = await this.options.load();
    return this.coordinator.enqueue({
      workflow: this.options.workflow,
      jobId,
      provider: context.settings.provider,
      model: context.settings.model,
      idempotencyKey,
      execute: ({ runId, signal, onUsage }) => this.work(runId, signal, jobId, payload, context, onUsage),
      onError: (error, { signal }) => ({
        error: signal.aborted || error instanceof PiRunCancelledError
          ? "Practice cancelled."
          : error instanceof PiRunTimeoutError
            ? "Practice timed out."
            : this.options.workflow === "follow_up"
              ? "Follow-up draft failed. Check provider settings and try again."
              : "Interview message failed. Previous messages were kept.",
      }),
    });
  }

  cancel(id: string) { return this.coordinator.cancel(id); }

  private async work(id: string, signal: AbortSignal, jobId: string, payload: unknown, context: { profile: string; settings: Settings }, onUsage: (usage: PiRunUsage) => void) {
    try {
      const summary = await this.options.execute({ jobId, payload, ...context, signal, runId: id, trajectory: this.options.trajectory, onUsage });
      if (signal.aborted) throw new PiRunCancelledError();
      return summary;
    } catch (error) {
      throw error;
    }
  }
}
