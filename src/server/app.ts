import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { z, ZodError } from "zod";
import {
  archiveJob,
  createTaskReporter,
  createTrajectoryRecorder,
  getActiveRun,
  getEligibleInterviewJobs,
  getJob,
  getJobDetail,
  getRun,
  listRunTrajectoryEvents,
  listRuns,
  listJobs,
  markApplied,
  markFollowUpSent,
  approveApplication,
  resetInterview,
  restoreJob,
  saveFollowUpDraft,
  saveInterviewMessages,
  saveInterviewNotes,
  setJobStage,
  toggleSelection,
  updateFollowUpDraft,
  updateJob,
  updateJobDirection,
} from "./db.js";
import {
  CriteriaSchema,
  ProfileSchema,
  readCriteria,
  readLegacyProfile,
  readProfile,
  readProviderContext,
  readSettings,
  readStructuredProfile,
  writeCriteria,
  writeLegacyCompatibilityProfile,
  writeSettings,
  writeStructuredProfile,
} from "./config.js";
import { liveScrapeExecutor, GenerationRunManager, RunManager, type ScrapeExecutor } from "./runs.js";
import { jobStages, type JobStage } from "./stages.js";
import { generationRevisionCap, revisionCapError, type GenerationExecutor } from "./generation.js";
import type { StrategistFn } from "./agents/strategist.js";
import type { CommandRunner } from "./documents.js";
import { containedPath, friendlyDocumentFilename, runCommand } from "./documents.js";
import {
  FollowUpContextSchema,
  InterviewRequestSchema,
  boundedInterviewHistory,
  createLiveInterviewExecutor,
  liveFollowUpExecutor,
  TaskRunManager,
  type FollowUpExecutor,
  type InterviewDocumentContext,
  type InterviewExecutor,
} from "./interview.js";
import { type FollowUpContext, type InterviewMessage, type StructuredProfile } from "../shared.js";
import { createRestrictedGenerationSession, getAvailablePiModels, runBoundedPi, type PiModelOption } from "./pi.js";
import { InterviewSessionPool, type InterviewSessionFactory } from "./interview-sessions.js";
import { MAX_PROFILE_UPLOAD_BYTES, ProfileImportRunManager, type ProfileImporter } from "./profile-import.js";
import { importManualJob, ManualJobRunManager, MAX_MANUAL_INPUT_LENGTH, type ManualJobImporter } from "./manual-job.js";
import { RunCoordinator } from "./coordinator.js";

export interface ServerOptions {
  dataDir?: string;
  db?: DatabaseSync;
  scrapeExecutor?: ScrapeExecutor;
  generationExecutor?: GenerationExecutor;
  strategist?: StrategistFn;
  interviewExecutor?: InterviewExecutor;
  interviewSessionFactory?: InterviewSessionFactory;
  followUpExecutor?: FollowUpExecutor;
  commandRunner?: CommandRunner;
  documentStatusRunner?: CommandRunner;
  availableModels?: (provider: string) => Promise<readonly PiModelOption[]>;
  profileImporter?: ProfileImporter;
  manualImporter?: ManualJobImporter;
  projectRoot?: string;
}

const criteriaInputSchema = CriteriaSchema.superRefine((value, context) => {
  if (!value.roles.length) context.addIssue({ code: "custom", path: ["roles"], message: "Add at least one target role." });
  if (!value.locations.length) context.addIssue({ code: "custom", path: ["locations"], message: "Add at least one target location." });
});
const isoDate = z.string().refine((value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return !Number.isNaN(new Date(`${value}T00:00:00.000Z`).valueOf()) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(new Date(value).valueOf());
}, "Invalid date.");

function requestId(req: { params: unknown }) { return (req.params as { id: string }).id; }
function requestIdempotencyKey(req: { headers: Record<string, string | string[] | undefined> }) {
  const value = req.headers["idempotency-key"];
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}
function notFound(message: string) { return Object.assign(new Error(message), { statusCode: 404 }); }
async function readOptionalFile(path: string) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function readInterviewDocuments(dataDir: string, jobId: string): Promise<InterviewDocumentContext> {
  const currentDir = containedPath(dataDir, "applications", jobId, "current");
  return {
    cv: await readOptionalFile(containedPath(currentDir, "cv.tex")),
    coverLetter: await readOptionalFile(containedPath(currentDir, "cover-letter.tex")),
  };
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: MAX_PROFILE_UPLOAD_BYTES + 1_048_576 });
  await app.register(multipart, { limits: { fileSize: MAX_PROFILE_UPLOAD_BYTES, files: 1, fields: 1, parts: 2 } });
  const dataDir = options.dataDir ?? join(process.cwd(), "data");
  const db = options.db ?? (await import("./db.js")).openDatabase(join(dataDir, "jobs.sqlite3"));
  const ownsDb = !options.db;
  const trajectory = createTrajectoryRecorder(db);
  const coordinator = new RunCoordinator({ db, trajectory });
  const interviewSessionPool = options.interviewExecutor ? undefined : new InterviewSessionPool({
    createSession: options.interviewSessionFactory ?? (({ settings, systemPrompt }) => createRestrictedGenerationSession(settings, systemPrompt)),
  });
  const defaultInterviewExecutor: InterviewExecutor = options.interviewExecutor
    ?? (interviewSessionPool
      ? createLiveInterviewExecutor(interviewSessionPool)
      : async () => { throw new Error("Live interview executor is unavailable."); });
  const baseLoad = async (purpose: "scrape" | "generation" | "interview" | "follow_up") => ({
    profile: await (async () => {
      try { return await readProviderContext(dataDir, purpose); }
      catch (error) {
        // Injected deterministic test executors predate structured-profile persistence;
        // live Pi workflows never take this compatibility path.
        const injected = purpose === "scrape" ? options.scrapeExecutor : purpose === "generation" ? options.generationExecutor : purpose === "interview" ? (options.interviewExecutor ?? options.interviewSessionFactory) : options.followUpExecutor;
        if (injected) return readProfile(dataDir);
        throw error;
      }
    })(),
    criteria: await readCriteria(dataDir),
    settings: await readSettings(dataDir),
  });
  const manager = new RunManager(db, options.scrapeExecutor ?? liveScrapeExecutor, async () => {
    const context = await baseLoad("scrape");
    return { profile: context.profile, criteria: context.criteria, settings: context.settings };
  }, trajectory, coordinator);
  let generation!: GenerationRunManager;
  let interview!: TaskRunManager;
  let followUp!: TaskRunManager;
  let manual!: ManualJobRunManager;
  let profileImport!: ProfileImportRunManager;
  // Live interviewer text per run, consumed by the SSE stream endpoint. At most
  // one interview run is active at a time; finished entries are pruned on the next start.
  const interviewStreams = new Map<string, { jobId: string; text: string; done: boolean }>();
  manual = new ManualJobRunManager({
    db,
    importer: options.manualImporter ?? importManualJob,
    trajectory,
    load: async () => {
      const settings = await readSettings(dataDir);
      let profile: string;
      try { profile = await readProviderContext(dataDir, "manual_import"); }
      catch { throw Object.assign(new Error("Review and save a structured profile before adding a job."), { statusCode: 409 }); }
      return { profile, criteria: await readCriteria(dataDir), settings };
    },
    coordinator,
  });
  profileImport = new ProfileImportRunManager({
    db,
    importer: options.profileImporter,
    trajectory,
    load: async () => ({ settings: await readSettings(dataDir) }),
    coordinator,
  });
  generation = new GenerationRunManager({
    db,
    dataDir,
    projectRoot: options.projectRoot,
    execute: options.generationExecutor,
    runner: options.commandRunner,
    trajectory,
    strategist: options.strategist,
    load: async () => {
      const context = await baseLoad("generation");
      return { profile: context.profile, settings: context.settings };
    },
    coordinator,
  });
  interview = new TaskRunManager({
    db,
    workflow: "interview",
    load: async () => {
      const context = await baseLoad("interview");
      return { profile: context.profile, settings: context.settings };
    },
    coordinator,
    trajectory,
    execute: async ({ jobId, payload, profile, settings, signal, runId, trajectory: runTrajectory, onUsage }) => {
      const tasks = createTaskReporter(runTrajectory, runId);
      tasks.start({ taskId: `interview:${jobId}:prepare`, label: "Prepare interview context", detail: jobId });
      // The buffer entry is inserted by the POST route right after start() resolves,
      // which may be after this executor began; look it up lazily.
      const streamFor = () => (runId ? interviewStreams.get(runId) : undefined);
      try {
        const input = InterviewRequestSchema.parse(payload);
        const job = getJobDetail(db, jobId);
        if (!job || (job.stage !== "Applied" && job.stage !== "Interview")) throw Object.assign(new Error("Interview practice is only available for Applied or Interview jobs."), { statusCode: 409 });
        const jobDetail = `${String(job.role)} · ${String(job.company)}`;
        const messages = boundedInterviewHistory((job.interview_messages ?? []) as InterviewMessage[]);
        const documents = await readInterviewDocuments(dataDir, jobId);
        tasks.complete(`interview:${jobId}:prepare`, jobDetail);
        tasks.start({ taskId: `interview:${jobId}:response`, label: "Generate interviewer response", detail: jobDetail });
        const assistant = await defaultInterviewExecutor({
          profile,
          job: job as unknown as Record<string, unknown>,
          documents,
          messages,
          focus: input.focus,
          message: input.message,
          settings,
          signal,
          runId,
          trajectory: runTrajectory,
          onDelta: (fullText) => { const stream = streamFor(); if (stream) stream.text = fullText; },
          onUsage,
        });
        tasks.complete(`interview:${jobId}:response`, jobDetail);
        tasks.start({ taskId: `interview:${jobId}:save`, label: "Save response", detail: jobDetail });
        const now = new Date().toISOString();
        const next = [...messages, { role: "user", content: input.message, createdAt: now } as InterviewMessage, { role: "assistant", content: assistant, createdAt: new Date().toISOString() } as InterviewMessage];
        try {
          saveInterviewMessages(db, jobId, next, now);
        } catch (error) {
          try { await interviewSessionPool?.invalidate(jobId); } catch { /* preserve the persistence failure */ }
          throw error;
        }
        tasks.complete(`interview:${jobId}:save`, jobDetail);
        return { jobId, messageCount: next.length };
      } finally {
        const stream = streamFor();
        if (stream) stream.done = true;
        tasks.failActive(signal.aborted ? "Run cancelled." : "Task failed.");
      }
    },
  });
  followUp = new TaskRunManager({
    db,
    workflow: "follow_up",
    load: async () => {
      const context = await baseLoad("follow_up");
      return { profile: context.profile, settings: context.settings };
    },
    coordinator,
    trajectory,
    execute: async ({ jobId, payload, profile, settings, signal, runId, trajectory: runTrajectory, onUsage }) => {
      const tasks = createTaskReporter(runTrajectory, runId);
      tasks.start({ taskId: `follow_up:${jobId}:prepare`, label: "Prepare follow-up context", detail: jobId });
      try {
        const input = z.object({ context: FollowUpContextSchema, dueAt: z.union([isoDate, z.literal("")]).default("") }).strict().parse(payload);
        const job = getJobDetail(db, jobId);
        if (!job || (job.stage !== "Applied" && job.stage !== "Interview")) throw Object.assign(new Error("Follow-up is only available for Applied or Interview jobs."), { statusCode: 409 });
        const jobDetail = `${String(job.role)} · ${String(job.company)}`;
        tasks.complete(`follow_up:${jobId}:prepare`, jobDetail);
        tasks.start({ taskId: `follow_up:${jobId}:draft`, label: "Draft follow-up message", detail: jobDetail });
        const draft = await (options.followUpExecutor ?? liveFollowUpExecutor)({ profile, job: job as unknown as Record<string, unknown>, interviewNotes: String(job.interview_notes ?? ""), followUp: input.context, settings, signal, runId, trajectory: runTrajectory, onUsage });
        tasks.complete(`follow_up:${jobId}:draft`, jobDetail);
        tasks.start({ taskId: `follow_up:${jobId}:save`, label: "Save draft", detail: jobDetail });
        saveFollowUpDraft(db, jobId, draft, input.context, input.dueAt || null);
        tasks.complete(`follow_up:${jobId}:save`, jobDetail);
        return { jobId, draftSaved: true };
      } finally {
        tasks.failActive(signal.aborted ? "Run cancelled." : "Task failed.");
      }
    },
  });

  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host;
    if (host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return reply.code(400).send({ error: "Invalid Host header." });
  });
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: status >= 500 ? "Request failed." : error.message });
  });

  app.get("/health", async () => ({ ok: true, service: "job-sequencer" }));

  app.get("/api/profile", async () => {
    const state = await readStructuredProfile(dataDir);
    return { profile: state.profile, canonical: state.canonical, legacyImportAvailable: Boolean(state.legacyImport) };
  });
  app.get("/api/profile/legacy", async () => {
    const content = await readLegacyProfile(dataDir);
    if (content === null) throw notFound("Legacy profile backup not found.");
    return { content };
  });
  app.put("/api/profile", async (req) => {
    const body = req.body as unknown;
    const value = body && typeof body === "object" && "profile" in body ? (body as { profile: unknown }).profile : body;
    // Backward-compatible only for existing Phase 1–2 API callers; the production UI sends the strict object.
    const profile = typeof value === "string" ? await writeLegacyCompatibilityProfile(dataDir, value) : await writeStructuredProfile(dataDir, ProfileSchema.parse(value));
    return { profile, canonical: true, legacyImportAvailable: Boolean(await readLegacyProfile(dataDir)) };
  });
  app.post("/api/profile/import", async (req, reply) => {
    let upload: { filename: string; mimetype: string; buffer: Buffer } | undefined;
    let currentProfileRaw: string | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file") throw Object.assign(new Error("Upload one PDF, DOC, or DOCX file in the file field."), { statusCode: 400 });
        if (upload) throw Object.assign(new Error("Upload exactly one resume/CV file."), { statusCode: 400 });
        upload = { filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() };
        continue;
      }
      if (part.fieldname === "currentProfile") {
        currentProfileRaw = typeof part.value === "string" ? part.value : String(part.value);
      }
    }
    if (!upload) throw Object.assign(new Error("Upload one PDF, DOC, or DOCX file in the file field."), { statusCode: 400 });
    let currentProfile: StructuredProfile | null = null;
    if (currentProfileRaw?.trim()) {
      try { currentProfile = ProfileSchema.parse(JSON.parse(currentProfileRaw)) as StructuredProfile; }
      catch { throw Object.assign(new Error("currentProfile must be valid structured profile JSON."), { statusCode: 400 }); }
    }
    return reply.code(202).send({ runId: await profileImport.start(upload, currentProfile, requestIdempotencyKey(req)) });
  });
  app.get("/api/profile/export", async (req) => {
    const purpose = z.enum(["preview", "scrape", "generation", "interview", "follow_up"]).parse((req.query as { purpose?: string }).purpose ?? "preview");
    return { purpose, text: await readProviderContext(dataDir, purpose) };
  });

  app.get("/api/criteria", () => readCriteria(dataDir));
  app.put("/api/criteria", (req) => writeCriteria(dataDir, criteriaInputSchema.parse(req.body)));
  app.get("/api/settings", () => readSettings(dataDir));
  app.put("/api/settings", (req) => writeSettings(dataDir, req.body));
  app.get("/api/ai/models", async (req) => {
    const provider = z.object({ provider: z.string().trim().min(1).max(80) }).parse(req.query).provider;
    const models = await (options.availableModels ?? getAvailablePiModels)(provider);
    return { provider, models };
  });
  app.get("/api/document-status", async () => {
    const runner = options.documentStatusRunner ?? runCommand;
    const tools = Object.fromEntries(await Promise.all(["lualatex", "xelatex", "pdfinfo", "pdftotext"].map(async (executable) => {
      try {
        const result = await runner(executable, [executable === "pdfinfo" || executable === "pdftotext" ? "-v" : "--version"], 3_000);
        return [executable, { available: result.code === 0 }] as const;
      } catch {
        return [executable, { available: false }] as const;
      }
    })));
    try {
      const loaded = await (await import("./templates.js")).loadTemplateMetadata(options.projectRoot ?? process.cwd());
      return {
        tools,
        templates: {
          cv: { available: true, names: Object.keys(loaded.metadata.cv) },
          coverLetter: { available: true },
        },
      };
    } catch {
      return {
        tools,
        templates: {
          cv: { available: false, names: [] },
          coverLetter: { available: false },
        },
      };
    }
  });
  app.post("/api/ai/test", async (req) => {
    const settings = await readSettings(dataDir);
    const existing = coordinator.findByIdempotencyKey(requestIdempotencyKey(req));
    if (existing) {
      const run = await coordinator.waitForCompletion(existing);
      if (run.status !== "succeeded") throw new Error(run.error ?? "Provider test failed.");
      return { ok: true };
    }
    let text = "";
    const runId = await coordinator.enqueue({
      workflow: "test",
      provider: settings.provider,
      model: settings.model,
      idempotencyKey: requestIdempotencyKey(req),
      execute: ({ runId: admittedRunId, signal, onUsage }) => runBoundedPi({
        prompt: "Reply with exactly OK and nothing else.",
        timeoutMs: 30_000,
        signal,
        runId: admittedRunId,
        trajectory,
        onUsage,
        createSession: () => createRestrictedGenerationSession(settings, "You are a connection test. Reply with exactly OK."),
        onEvent: (event) => {
          const value = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
          if (value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta") text += value.assistantMessageEvent.delta ?? "";
        },
      }),
      onError: () => ({ error: "Provider test failed." }),
    });
    const run = await coordinator.waitForCompletion(runId);
    if (run.status !== "succeeded") throw new Error(run.error ?? "Provider test failed.");
    if (!text.trim()) throw new Error("Provider returned no test response.");
    return { ok: true };
  });

  app.get("/api/jobs", async (req) => {
    const query = z.object({ stage: z.string().optional() }).parse(req.query);
    const stages = query.stage ? query.stage.split(",").filter((stage): stage is JobStage => jobStages.includes(stage as JobStage)) : undefined;
    return { jobs: listJobs(db, stages) };
  });
  app.get("/api/applications", async () => ({ jobs: listJobs(db, ["Selected", "Drafting", "Ready", "Applied", "Interview", "Offer", "Rejected"]) }));
  app.post("/api/jobs/manual", async (req, reply) => {
    const body = z.object({ input: z.string().max(MAX_MANUAL_INPUT_LENGTH).refine((value) => Boolean(value.trim()), "Enter a posting URL or paste job text.") }).strict().parse(req.body);
    return reply.code(202).send({ runId: await manual.start(body.input, requestIdempotencyKey(req)) });
  });
  app.get("/api/jobs/:id", async (req) => {
    const row = getJobDetail(db, requestId(req));
    if (!row) throw notFound("Job not found.");
    return row;
  });
  app.patch("/api/jobs/:id", async (req) => {
    const body = z.object({ notes: z.string().max(20_000).optional(), applicationNotes: z.string().max(20_000).optional() }).strict().parse(req.body);
    const row = updateJob(db, requestId(req), body);
    if (!row) throw notFound("Job not found.");
    return row;
  });
  app.put("/api/jobs/:id/direction", async (req) => {
    const body = z.object({
      cvLength: z.enum(["short", "complete"]).optional(),
      letterMode: z.enum(["standard", "exploratory"]).optional(),
      letterNarration: z.string().max(500).optional(),
      revisionNotes: z.string().max(2000).optional(),
      revisionCount: z.number().int().min(0).max(3).optional(),
    }).strict().parse(req.body ?? {});
    const row = updateJobDirection(db, requestId(req), body);
    if (!row) throw notFound("Job not found.");
    return row;
  });
  app.post("/api/jobs/:id/select", async (req) => {
    const row = toggleSelection(db, requestId(req));
    if (!row) throw notFound("Job not found.");
    return row;
  });
  app.post("/api/jobs/bulk", async (req) => {
    const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(100), action: z.enum(["select", "unselect", "archive"]) }).strict().parse(req.body);
    if (new Set(body.ids).size !== body.ids.length) throw new Error("Duplicate job IDs are not allowed.");
    for (const id of body.ids) {
      if (body.action === "archive") archiveJob(db, id);
      else {
        const row = getJob(db, id) as { stage: JobStage } | undefined;
        if (!row) throw notFound("Job not found.");
        if (body.action === "select" && row.stage === "Recommended") toggleSelection(db, id);
        if (body.action === "unselect" && row.stage === "Selected") toggleSelection(db, id);
      }
    }
    return { jobs: body.ids.map((id) => getJobDetail(db, id)).filter(Boolean) };
  });
  app.post("/api/jobs/:id/archive", async (req) => archiveJob(db, requestId(req)));
  app.post("/api/jobs/:id/restore", async (req) => restoreJob(db, requestId(req)));
  app.post("/api/jobs/:id/restore-recommended", async (req) => setJobStage(db, requestId(req), "Recommended"));
  app.post("/api/jobs/:id/outcome", async (req) => {
    const body = z.object({ stage: z.enum(["Interview", "Offer", "Rejected"]), notes: z.string().max(20_000).default("") }).strict().parse(req.body);
    const row = setJobStage(db, requestId(req), body.stage);
    updateJob(db, requestId(req), { applicationNotes: body.notes });
    return row;
  });

  app.post("/api/scrape", async (req, reply) => {
    return reply.code(202).send({ runId: await manager.start(requestIdempotencyKey(req)) });
  });
  app.post("/api/generate", async (req, reply) => {
    const idempotencyKey = requestIdempotencyKey(req);
    const existing = coordinator.findByIdempotencyKey(idempotencyKey);
    if (existing) return reply.code(202).send({ runId: existing });
    const { jobIds } = z.object({ jobIds: z.array(z.string().uuid()).min(1).max(20).refine((value) => new Set(value).size === value.length, "Duplicate job IDs are not allowed.") }).strict().parse(req.body);
    for (const id of jobIds) {
      const job = getJob(db, id) as { stage: string } | undefined;
      if (!job) throw notFound("Job not found.");
      if (job.stage !== "Selected") throw Object.assign(new Error("Only Selected jobs may generate."), { statusCode: 409 });
    }
    return reply.code(202).send({ runId: await generation.start(jobIds, false, idempotencyKey) });
  });
  app.post("/api/jobs/:id/regenerate", async (req, reply) => {
    const idempotencyKey = requestIdempotencyKey(req);
    const existing = coordinator.findByIdempotencyKey(idempotencyKey);
    if (existing) return reply.code(202).send({ runId: existing });
    const id = requestId(req);
    const job = getJobDetail(db, id);
    if (!job) throw notFound("Job not found.");
    if (job.stage !== "Drafting" && job.stage !== "Ready") throw Object.assign(new Error("Only Drafting or Ready jobs may regenerate."), { statusCode: 409 });
    if ((job.generation_direction?.revisionCount ?? 0) >= generationRevisionCap) throw Object.assign(new Error(revisionCapError), { statusCode: 409 });
    return reply.code(202).send({ runId: await generation.start([id], true, idempotencyKey) });
  });
  app.post("/api/jobs/:id/approve", async (req) => approveApplication(db, requestId(req)));
  app.post("/api/jobs/:id/applied", async (req) => {
    const body = z.object({ submittedAt: isoDate, channel: z.string().trim().max(120).default(""), notes: z.string().max(20_000).default("") }).strict().parse(req.body);
    return markApplied(db, requestId(req), body);
  });

  app.get("/api/interview", async () => ({ jobs: getEligibleInterviewJobs(db) }));
  app.get("/api/jobs/:id/interview", async (req) => {
    const job = getJobDetail(db, requestId(req));
    if (!job || (job.stage !== "Applied" && job.stage !== "Interview")) throw notFound("Interview workspace not found.");
    return { job, messages: job.interview_messages ?? [], notes: job.interview_notes ?? "" };
  });
  app.post("/api/jobs/:id/interview", async (req, reply) => {
    const idempotencyKey = requestIdempotencyKey(req);
    const existing = coordinator.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (!interviewStreams.has(existing)) interviewStreams.set(existing, { jobId: requestId(req), text: "", done: false });
      return reply.code(202).send({ runId: existing });
    }
    const id = requestId(req);
    const job = getJobDetail(db, id);
    if (!job || (job.stage !== "Applied" && job.stage !== "Interview")) throw Object.assign(new Error("Interview practice is only available for Applied or Interview jobs."), { statusCode: 409 });
    for (const [finishedRunId, entry] of interviewStreams) if (entry.done) interviewStreams.delete(finishedRunId);
    const runId = await interview.start(id, InterviewRequestSchema.parse(req.body), idempotencyKey);
    interviewStreams.set(runId, { jobId: id, text: "", done: false });
    return reply.code(202).send({ runId });
  });
  app.get("/api/jobs/:id/interview/stream", async (req, reply) => {
    const runId = String((req.query as { runId?: string }).runId ?? "");
    const stream = interviewStreams.get(runId);
    if (!stream || stream.jobId !== requestId(req)) throw notFound("No active interview stream for this run.");
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    reply.raw.write("retry: 1000\n\n");
    let sent = 0;
    const flush = () => {
      if (sent < stream.text.length) {
        reply.raw.write(`data: ${JSON.stringify({ text: stream.text })}\n\n`);
        sent = stream.text.length;
      }
      if (stream.done) {
        clearInterval(timer);
        reply.raw.write("event: done\ndata: {}\n\n");
        reply.raw.end();
        interviewStreams.delete(runId);
      }
    };
    const timer = setInterval(flush, 120);
    req.raw.on("close", () => clearInterval(timer));
  });
  app.patch("/api/jobs/:id/interview", async (req) => {
    const body = z.object({ notes: z.string().max(30_000) }).strict().parse(req.body);
    return saveInterviewNotes(db, requestId(req), body.notes);
  });
  app.delete("/api/jobs/:id/interview", async (req) => {
    const id = requestId(req);
    const result = resetInterview(db, id);
    await interviewSessionPool?.invalidate(id);
    return result;
  });

  app.post("/api/jobs/:id/follow-up", async (req, reply) => {
    const idempotencyKey = requestIdempotencyKey(req);
    const existing = coordinator.findByIdempotencyKey(idempotencyKey);
    if (existing) return reply.code(202).send({ runId: existing });
    const id = requestId(req);
    const job = getJobDetail(db, id);
    if (!job || (job.stage !== "Applied" && job.stage !== "Interview")) throw Object.assign(new Error("Follow-up is only available for Applied or Interview jobs."), { statusCode: 409 });
    const payload = z.object({ context: FollowUpContextSchema, dueAt: z.union([isoDate, z.literal("")]).default("") }).strict().parse(req.body);
    return reply.code(202).send({ runId: await followUp.start(id, payload, idempotencyKey) });
  });
  app.patch("/api/jobs/:id/follow-up", async (req) => {
    const body = z.object({ draft: z.string().max(30_000) }).strict().parse(req.body);
    return updateFollowUpDraft(db, requestId(req), body.draft);
  });
  app.post("/api/jobs/:id/follow-up/sent", async (req) => markFollowUpSent(db, requestId(req)));

  const files = { "cv.tex": "text/plain; charset=utf-8", "cv.pdf": "application/pdf", "cover-letter.tex": "text/plain; charset=utf-8", "cover-letter.pdf": "application/pdf", "verification.json": "application/json; charset=utf-8" } as const;
  app.get("/api/files/:jobId/:name", async (req, reply) => {
    const { jobId, name } = req.params as { jobId: string; name: string };
    z.string().uuid().parse(jobId);
    if (!Object.hasOwn(files, name)) throw notFound("File not found.");
    const job = getJob(db, jobId) as { company: string; role: string } | undefined;
    if (!job) throw notFound("File not found.");
    const path = containedPath(dataDir, "applications", jobId, "current", name);
    try {
      const filename = friendlyDocumentFilename(name, job.company, job.role);
      return reply.type(files[name as keyof typeof files]).header("Content-Disposition", `inline; filename="${filename}"`).send(await readFile(path));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound("File not found."); throw error; }
  });

  app.get("/api/runs", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    return { runs: listRuns(db, limit) };
  });
  app.get("/api/runs/active", async () => ({ run: getActiveRun(db) }));
  app.get("/api/runs/:id/trajectory", async (req) => {
    const id = requestId(req);
    const run = getRun(db, id);
    if (!run) throw notFound("Run not found.");
    return { runId: id, status: run.status, events: listRunTrajectoryEvents(db, id) };
  });
  app.get("/api/runs/:id", async (req) => {
    const row = getRun(db, requestId(req));
    if (!row) throw notFound("Run not found.");
    return row;
  });
  app.post("/api/runs/:id/cancel", async (req) => {
    const id = requestId(req);
    if (!coordinator.cancel(id)) throw notFound("Running job not found.");
    return { ok: true };
  });

  app.addHook("onClose", async () => {
    await coordinator.close();
    await interviewSessionPool?.close();
    if (ownsDb) db.close();
  });
  return app;
}

export async function startServer(port = 3000): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ host: "127.0.0.1", port });
  return app;
}
