import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type FollowUpContext, type InterviewMessage, type RunStatus, type RunWorkflow, type TrajectoryRecorder } from "../shared.js";
import type { Settings } from "./config.js";
import { createRestrictedGenerationSession, PiRunCancelledError, PiRunTimeoutError, runBoundedPi } from "./pi.js";
import { loadGuidance } from "./guidance.js";
import { projectPromptContext, trustedSection, untrustedSection } from "./context.js";

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
}) => Promise<string>;

async function runTextSession(prompt: string, settings: Settings, signal: AbortSignal, systemPrompt: string, runId?: string, trajectory?: TrajectoryRecorder, onDelta?: (fullText: string) => void) {
  let text = "";
  await runBoundedPi({
    prompt,
    timeoutMs: 120_000,
    signal,
    createSession: () => createRestrictedGenerationSession(settings, systemPrompt),
    runId,
    trajectory,
    onEvent: (event) => {
      const value = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
      if (value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta") {
        text += value.assistantMessageEvent.delta ?? "";
        try { onDelta?.(text); } catch { /* streaming is deliberately non-fatal */ }
      }
    },
  });
  if (!text.trim()) throw new Error("Provider returned an empty response.");
  return text.trim();
}

export const liveInterviewExecutor: InterviewExecutor = async (context) => runTextSession(
  [
    trustedSection("INSTRUCTIONS", "Act as a concise, truthful interviewer. Ask one question at a time, respond to the latest answer with short feedback, and use only the supplied context."),
    trustedSection("INTERVIEW GUIDANCE", await loadGuidance(["interviewPrep"])),
    trustedSection("CANDIDATE PROFILE", context.profile),
    trustedSection("JOB METADATA", JSON.stringify(projectPromptContext(Object.fromEntries(Object.entries(context.job).filter(([key]) => key !== "posting"))))),
    untrustedSection("JOB POSTING", String(context.job.posting ?? "")),
    trustedSection("GENERATED DOCUMENTS", JSON.stringify(projectPromptContext(context.documents))),
    trustedSection("PRIOR MESSAGES", JSON.stringify(projectPromptContext(context.messages))),
    trustedSection("FOCUS", context.focus || "(none)"),
    untrustedSection("LATEST USER ANSWER", context.message),
  ].join("\n"),
  context.settings,
  context.signal,
  "You are a bounded mock interviewer. Do not invent candidate facts or job requirements.",
  context.runId,
  context.trajectory,
  context.onDelta,
);

export const liveFollowUpExecutor: FollowUpExecutor = async (context) => runTextSession(
  [
    trustedSection("INSTRUCTIONS", "Draft one editable professional follow-up message. Return only the message body."),
    trustedSection("WRITING GUIDANCE", await loadGuidance(["writingStyle", "coverLetterTemplates"])),
    trustedSection("CANDIDATE PROFILE", context.profile),
    trustedSection("JOB METADATA", JSON.stringify(projectPromptContext(context.job))),
    trustedSection("INTERVIEW NOTES", context.interviewNotes),
    trustedSection("FOLLOW-UP REQUEST", JSON.stringify(projectPromptContext(context.followUp))),
  ].join("\n"),
  context.settings,
  context.signal,
  "You draft a truthful follow-up from the supplied profile and application context only.",
  context.runId,
  context.trajectory,
);

export type TaskRunExecutor = (context: { jobId: string; payload: unknown; profile: string; settings: Settings; signal: AbortSignal; runId?: string; trajectory?: TrajectoryRecorder }) => Promise<unknown>;

function recordTaskEvent(trajectory: TrajectoryRecorder | undefined, runId: string, event: Parameters<TrajectoryRecorder>[1]) {
  try { trajectory?.(runId, event); } catch { /* telemetry is deliberately non-fatal */ }
}

/** One compact run wrapper for the two user-triggered text workflows. */
export class TaskRunManager {
  private active: { id: string; controller: AbortController } | undefined;

  constructor(private readonly options: {
    db: DatabaseSync;
    workflow: Extract<RunWorkflow, "interview" | "follow_up">;
    load: () => Promise<{ profile: string; settings: Settings }>;
    execute: TaskRunExecutor;
    otherActive?: () => boolean;
    trajectory?: TrajectoryRecorder;
  }) {}

  isActive() { return Boolean(this.active); }

  async start(jobId: string, payload: unknown) {
    if (this.active || this.options.otherActive?.()) throw Object.assign(new Error("Another AI run is already active."), { statusCode: 409 });
    const id = randomUUID();
    const controller = new AbortController();
    const context = await this.options.load();
    const startedAt = new Date().toISOString();
    this.options.db.prepare("INSERT INTO runs(id,workflow,status,job_id,provider,model,started_at) VALUES(?,?, 'running',?,?,?,?)").run(id, this.options.workflow, jobId, context.settings.provider, context.settings.model, startedAt);
    recordTaskEvent(this.options.trajectory, id, { kind: "lifecycle", type: "run_started", timestamp: startedAt, startedAt, payload: { workflow: this.options.workflow, jobId } });
    this.active = { id, controller };
    void this.work(id, controller, jobId, payload, context);
    return id;
  }

  cancel(id: string) {
    if (this.active?.id !== id) return false;
    this.active.controller.abort();
    return true;
  }

  private async work(id: string, controller: AbortController, jobId: string, payload: unknown, context: { profile: string; settings: Settings }) {
    try {
      const summary = await this.options.execute({ jobId, payload, ...context, signal: controller.signal, runId: id, trajectory: this.options.trajectory });
      if (controller.signal.aborted) throw new PiRunCancelledError();
      this.finish(id, "succeeded", summary, null);
    } catch (error) {
      const status: RunStatus = error instanceof PiRunTimeoutError ? "timed_out" : controller.signal.aborted || error instanceof PiRunCancelledError ? "cancelled" : "failed";
      this.finish(id, status, null, status === "cancelled" ? "Practice cancelled." : status === "timed_out" ? "Practice timed out." : this.options.workflow === "follow_up" ? "Follow-up draft failed. Check provider settings and try again." : "Interview message failed. Previous messages were kept.");
    } finally {
      if (this.active?.id === id) this.active = undefined;
    }
  }

  private finish(id: string, status: RunStatus, summary: unknown, error: string | null) {
    const finishedAt = new Date().toISOString();
    recordTaskEvent(this.options.trajectory, id, { kind: status === "failed" || status === "timed_out" ? "error" : "lifecycle", type: status === "succeeded" ? "run_completed" : `run_${status}`, timestamp: finishedAt, endedAt: finishedAt, payload: { status, error } });
    this.options.db.prepare("UPDATE runs SET status=?,summary_json=?,error=?,finished_at=? WHERE id=?").run(status, summary === null ? null : JSON.stringify(summary), error, finishedAt, id);
  }
}
