import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { advancedStages, jobStages, type JobStage } from "./stages.js";
import { assertStageTransition, defaultGenerationDirection, type FollowUpContext, type GenerationDirection, type InterviewMessage, type Job, type Rank, type Run, type RunStatus, type TaskEventPayload, type TrajectoryEvent, type TrajectoryEventInput, type TrajectoryRecorder } from "../shared.js";
import type { ScrapeResult } from "./scrape.js";

const schema = `PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source TEXT NOT NULL, url TEXT NOT NULL UNIQUE, company TEXT NOT NULL, role TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', posting TEXT NOT NULL, score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100), rank_json TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('Recommended','Discarded','Selected','Drafting','Ready','Applied','Interview','Offer','Rejected','Archived')), notes TEXT NOT NULL DEFAULT '', archived_from_stage TEXT, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source,source_id));
CREATE INDEX IF NOT EXISTS jobs_stage_idx ON jobs(stage); CREATE INDEX IF NOT EXISTS jobs_score_idx ON jobs(score);
CREATE TABLE IF NOT EXISTS applications (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, cv_template TEXT, cv_source TEXT, cv_pdf TEXT, cover_letter_source TEXT, cover_letter_pdf TEXT, verification_json TEXT, approved_at TEXT, submitted_at TEXT, submission_channel TEXT, interview_notes TEXT NOT NULL DEFAULT '', interview_chat_json TEXT NOT NULL DEFAULT '[]', interview_updated_at TEXT, follow_up_draft TEXT NOT NULL DEFAULT '', follow_up_due_at TEXT, follow_up_sent_at TEXT, follow_up_context_json TEXT, generation_direction_json TEXT, outcome TEXT, notes TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL CHECK(workflow IN ('scrape','generate','interview','follow_up','manual_import','profile_import','test')), job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','timed_out')), provider TEXT NOT NULL, model TEXT NOT NULL, summary_json TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT, idempotency_key TEXT);
CREATE TABLE IF NOT EXISTS run_trajectory_events (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, kind TEXT NOT NULL, event_type TEXT NOT NULL, timestamp TEXT NOT NULL, started_at TEXT, ended_at TEXT, duration_ms REAL, payload_json TEXT, PRIMARY KEY(run_id, sequence));
CREATE INDEX IF NOT EXISTS run_trajectory_events_run_idx ON run_trajectory_events(run_id, sequence);
CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`;

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((value) => value.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateRunsWorkflow(db: DatabaseSync) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").get() as { sql?: string } | undefined;
  if (!row?.sql || (/manual_import/i.test(row.sql) && /profile_import/i.test(row.sql) && /'queued'/i.test(row.sql))) return;
  const columns = new Set((db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((value) => value.name));
  const runColumns = ["id", "workflow", "status", "job_id", "provider", "model", "summary_json", "error", "error_code", "attempt_count", "input_tokens", "output_tokens", "total_tokens", "estimated_cost", "prompt_hash", "guidance_hash", "settings_hash", "started_at", "finished_at", "idempotency_key"];
  const selectedColumns = runColumns.map((column) => columns.has(column) ? column : `NULL AS ${column}`).join(",");
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE runs_phase4 (id TEXT PRIMARY KEY, workflow TEXT NOT NULL CHECK(workflow IN ('scrape','generate','interview','follow_up','manual_import','profile_import','test')), job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','timed_out')), provider TEXT NOT NULL, model TEXT NOT NULL, summary_json TEXT, error TEXT, error_code TEXT, attempt_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, estimated_cost REAL, prompt_hash TEXT, guidance_hash TEXT, settings_hash TEXT, started_at TEXT NOT NULL, finished_at TEXT, idempotency_key TEXT);
      INSERT INTO runs_phase4(${runColumns.join(",")}) SELECT ${selectedColumns} FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_phase4 RENAME TO runs;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the original migration error */ }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

export function createSmokeDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
  return db;
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(schema);
  ensureColumn(db, "jobs", "archived_from_stage", "TEXT");
  ensureColumn(db, "applications", "interview_updated_at", "TEXT");
  ensureColumn(db, "applications", "follow_up_context_json", "TEXT");
  ensureColumn(db, "applications", "generation_direction_json", "TEXT");
  ensureColumn(db, "run_trajectory_events", "timestamp", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "run_trajectory_events", "started_at", "TEXT");
  ensureColumn(db, "run_trajectory_events", "ended_at", "TEXT");
  ensureColumn(db, "run_trajectory_events", "duration_ms", "REAL");
  ensureColumn(db, "run_trajectory_events", "payload_json", "TEXT");
  db.prepare("INSERT OR IGNORE INTO migrations(version,applied_at) VALUES(1,?)").run(new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO migrations(version,applied_at) VALUES(2,?)").run(new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO migrations(version,applied_at) VALUES(3,?)").run(new Date().toISOString());
  if (!(db.prepare("SELECT 1 FROM migrations WHERE version=4").get())) {
    migrateRunsWorkflow(db);
    db.prepare("INSERT INTO migrations(version,applied_at) VALUES(4,?)").run(new Date().toISOString());
  }
  if (!(db.prepare("SELECT 1 FROM migrations WHERE version=5").get())) {
    migrateRunsWorkflow(db);
    db.prepare("INSERT INTO migrations(version,applied_at) VALUES(5,?)").run(new Date().toISOString());
  }
  if (!(db.prepare("SELECT 1 FROM migrations WHERE version=6").get())) {
    migrateRunsWorkflow(db);
    db.prepare("INSERT INTO migrations(version,applied_at) VALUES(6,?)").run(new Date().toISOString());
  }
  ensureColumn(db, "runs", "error_code", "TEXT");
  ensureColumn(db, "runs", "attempt_count", "INTEGER");
  ensureColumn(db, "runs", "input_tokens", "INTEGER");
  ensureColumn(db, "runs", "output_tokens", "INTEGER");
  ensureColumn(db, "runs", "total_tokens", "INTEGER");
  ensureColumn(db, "runs", "estimated_cost", "REAL");
  ensureColumn(db, "runs", "prompt_hash", "TEXT");
  ensureColumn(db, "runs", "guidance_hash", "TEXT");
  ensureColumn(db, "runs", "settings_hash", "TEXT");
  ensureColumn(db, "runs", "idempotency_key", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_key_idx ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL");
  cleanupStaleRuns(db);
  return db;
}

export function cleanupStaleRuns(db: DatabaseSync, now = new Date().toISOString()) {
  const result = db.prepare("UPDATE runs SET status='failed', error=COALESCE(error,'Server restarted during run.'), finished_at=? WHERE status='running'").run(now);
  try {
    db.prepare("UPDATE runs SET error_code='server_restart' WHERE status='failed' AND error='Server restarted during run.' AND finished_at=? AND error_code IS NULL").run(now);
  } catch {}
  return result.changes;
}

export function reconcileQueuedRuns(db: DatabaseSync, now = new Date().toISOString()) {
  const result = db.prepare("UPDATE runs SET status='failed', error=COALESCE(error,'Server restarted before run started.'), error_code=COALESCE(error_code,'server_restart'), finished_at=? WHERE status='queued'").run(now);
  return result.changes;
}

export type RunUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
};

export type NewRun = {
  id: string;
  workflow: Run["workflow"];
  jobId?: string | null;
  status?: "queued" | "running";
  provider: string;
  model: string;
  startedAt: string;
  idempotencyKey?: string | null;
};

export function insertRun(db: DatabaseSync, value: NewRun) {
  db.prepare("INSERT INTO runs(id,workflow,status,job_id,provider,model,started_at,idempotency_key) VALUES(?,?,?,?,?,?,?,?)").run(
    value.id,
    value.workflow,
    value.status ?? "queued",
    value.jobId ?? null,
    value.provider,
    value.model,
    value.startedAt,
    value.idempotencyKey ?? null,
  );
}

export function createRun(db: DatabaseSync, value: NewRun) {
  insertRun(db, value);
  return value.id;
}

export function markRunRunning(db: DatabaseSync, id: string) {
  return db.prepare("UPDATE runs SET status='running' WHERE id=? AND status='queued'").run(id).changes > 0;
}

export function updateRunErrorCode(db: DatabaseSync, id: string, errorCode: string | null) {
  return db.prepare("UPDATE runs SET error_code=COALESCE(error_code,?) WHERE id=?").run(errorCode, id).changes > 0;
}

export function updateRunUsage(db: DatabaseSync, id: string, usage: RunUsage) {
  return db.prepare("UPDATE runs SET input_tokens=COALESCE(?,input_tokens),output_tokens=COALESCE(?,output_tokens),total_tokens=COALESCE(?,total_tokens),estimated_cost=COALESCE(?,estimated_cost) WHERE id=?").run(
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.estimatedCost,
    id,
  ).changes > 0;
}

export function finishRun(db: DatabaseSync, id: string, status: Exclude<RunStatus, "queued" | "running">, summary: unknown, error: string | null, errorCode: string | null, finishedAt = new Date().toISOString()) {
  const summaryJson = summary === undefined || summary === null ? null : JSON.stringify(summary);
  return db.prepare("UPDATE runs SET status=?,summary_json=?,error=?,error_code=COALESCE(?,error_code),finished_at=? WHERE id=? AND status IN ('queued','running')").run(status, summaryJson, error, errorCode, finishedAt, id).changes > 0;
}

export function normalizeUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_") || key === "ref") url.searchParams.delete(key);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.toString();
}

export function persistScrape(db: DatabaseSync, result: ScrapeResult, threshold = 60, now = new Date().toISOString(), maxJobsPerRun = 50) {
  const limit = Math.min(maxJobsPerRun, 50);
  if (!Number.isInteger(maxJobsPerRun) || maxJobsPerRun < 1) throw new Error("maximum jobs per run must be a positive integer");
  if (result.jobs.length > limit) throw new Error(`Scrape result exceeds the maximum of ${limit} jobs`);
  const sourceIds = new Set<string>();
  const urls = new Set<string>();
  for (const job of result.jobs) {
    const url = normalizeUrl(job.url);
    if (sourceIds.has(job.sourceId)) throw new Error(`duplicate source ID ${job.sourceId}`);
    if (urls.has(url)) throw new Error(`duplicate normalized URL ${url}`);
    sourceIds.add(job.sourceId);
    urls.add(url);
  }
  db.exec("BEGIN IMMEDIATE");
  let inserted = 0;
  let updated = 0;
  try {
    for (const job of result.jobs) {
      const url = normalizeUrl(job.url);
      const existing = db.prepare("SELECT id,stage FROM jobs WHERE url=? OR (source=? AND source_id=?)").get(url, job.source, job.sourceId) as { id: string; stage: JobStage } | undefined;
      const rank = JSON.stringify({ reason: job.reason, strengths: job.strengths, gaps: job.gaps });
      const stage = existing && advancedStages.includes(existing.stage) ? existing.stage : (job.score > threshold ? "Recommended" : "Discarded");
      if (existing) {
        db.prepare("UPDATE jobs SET source_id=?,source=?,url=?,company=?,role=?,location=?,posting=?,score=?,rank_json=?,stage=?,updated_at=? WHERE id=?").run(job.sourceId, job.source, url, job.company, job.role, job.location, job.posting, job.score, rank, stage, now, existing.id);
        updated++;
      } else {
        db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,location,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), job.sourceId, job.source, url, job.company, job.role, job.location, job.posting, job.score, rank, stage, now, now);
        inserted++;
      }
    }
    db.exec("COMMIT");
    return { inserted, updated };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function persistManualJob(db: DatabaseSync, value: { inputType: "url" | "text"; url: string; job: { company: string; role: string; location: string; posting: string; score: number; reason: string; strengths: string[]; gaps: string[] } }, threshold = 60, now = new Date().toISOString()) {
  const url = value.inputType === "url" ? normalizeUrl(value.url) : value.url;
  if (db.prepare("SELECT id FROM jobs WHERE url=?").get(url)) throw Object.assign(new Error("A job with this URL already exists."), { statusCode: 409 });
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) throw new Error("score threshold must be an integer between 0 and 100");
  if (!Number.isInteger(value.job.score) || value.job.score < 0 || value.job.score > 100) throw new Error("manual job score must be an integer between 0 and 100");
  const rank = JSON.stringify({ reason: value.job.reason, strengths: value.job.strengths, gaps: value.job.gaps });
  try {
    db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,location,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      randomUUID(), `manual-${randomUUID()}`, "manual", url, value.job.company, value.job.role, value.job.location, value.job.posting, value.job.score, rank, value.job.score > threshold ? "Recommended" : "Discarded", now, now,
    );
  } catch (error) {
    if (/unique/i.test(String(error))) throw Object.assign(new Error("A job with this URL already exists."), { statusCode: 409 });
    throw error;
  }
  const row = db.prepare(`${jobSelect} WHERE j.url=?`).get(url) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Manual job was not saved.");
  return mapJob(row);
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function parseGenerationDirection(raw: unknown): GenerationDirection {
  const parsed = jsonValue<unknown>(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...defaultGenerationDirection };
  const value = parsed as Record<string, unknown>;
  return {
    cvLength: value.cvLength === "short" || value.cvLength === "complete" ? value.cvLength : defaultGenerationDirection.cvLength,
    cvPagesOverride: typeof value.cvPagesOverride === "number" && Number.isInteger(value.cvPagesOverride) && value.cvPagesOverride >= 1 && value.cvPagesOverride <= 10 ? value.cvPagesOverride : defaultGenerationDirection.cvPagesOverride,
    letterMode: value.letterMode === "standard" || value.letterMode === "exploratory" ? value.letterMode : defaultGenerationDirection.letterMode,
    letterNarration: typeof value.letterNarration === "string" ? value.letterNarration.slice(0, 500) : defaultGenerationDirection.letterNarration,
    revisionNotes: typeof value.revisionNotes === "string" ? value.revisionNotes.slice(0, 2000) : defaultGenerationDirection.revisionNotes,
    revisionCount: typeof value.revisionCount === "number" && Number.isInteger(value.revisionCount) && value.revisionCount >= 0 && value.revisionCount <= 3 ? value.revisionCount : defaultGenerationDirection.revisionCount,
  };
}

function mapJob(row: Record<string, unknown>): Job {
  const { rank_json: _rankJson, verification_json: _verificationJson, interview_chat_json: _chatJson, follow_up_context_json: _followUpContextJson, generation_direction_json: _generationDirectionJson, ...value } = row;
  return {
    ...value,
    rank: jsonValue<Rank>(row.rank_json, { reason: "", strengths: [], gaps: [] }),
    verification: jsonValue(row.verification_json, null),
    interview_messages: jsonValue<InterviewMessage[]>(row.interview_chat_json, []),
    follow_up_context: jsonValue<FollowUpContext | null>(row.follow_up_context_json, null),
    generation_direction: parseGenerationDirection(row.generation_direction_json),
  } as unknown as Job;
}

const jobSelect = `SELECT j.*, a.cv_template, a.cv_source, a.cv_pdf, a.cover_letter_source, a.cover_letter_pdf, a.verification_json, a.approved_at, a.submitted_at, a.submission_channel, a.interview_notes, a.interview_chat_json, a.interview_updated_at, a.follow_up_draft, a.follow_up_due_at, a.follow_up_sent_at, a.follow_up_context_json, a.generation_direction_json, a.outcome, a.notes AS application_notes FROM jobs j LEFT JOIN applications a ON a.job_id=j.id`;

export function listJobs(db: DatabaseSync, stages?: JobStage[]) {
  const selected = stages?.length ? stages : ["Recommended", "Selected", "Drafting", "Ready", "Applied", "Interview", "Offer"] as JobStage[];
  const marks = selected.map(() => "?").join(",");
  return db.prepare(`${jobSelect} WHERE j.stage IN (${marks}) ORDER BY j.score DESC,j.first_seen_at DESC`).all(...selected).map((row) => mapJob(row as Record<string, unknown>));
}

export function getJob(db: DatabaseSync, id: string) { return db.prepare("SELECT * FROM jobs WHERE id=?").get(id); }

export function getJobDetail(db: DatabaseSync, id: string) {
  const row = db.prepare(`${jobSelect} WHERE j.id=?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapJob(row) : undefined;
}

function ensureJob(db: DatabaseSync, id: string) {
  const job = getJob(db, id) as { id: string; stage: JobStage; archived_from_stage?: JobStage | null } | undefined;
  if (!job) throw Object.assign(new Error("Job not found."), { statusCode: 404 });
  return job;
}

export function setJobStage(db: DatabaseSync, id: string, stage: JobStage, now = new Date().toISOString()) {
  const current = ensureJob(db, id);
  if (current.stage === stage) return getJobDetail(db, id);
  if (current.stage === "Archived") {
    if (stage !== (current.archived_from_stage ?? "Recommended")) throw Object.assign(new Error("Archived jobs can only be restored to their previous active stage."), { statusCode: 409 });
  } else {
    try { assertStageTransition(current.stage, stage); } catch (error) { throw Object.assign(error as Error, { statusCode: 409 }); }
  }
  db.prepare("UPDATE jobs SET stage=?,archived_from_stage=?,updated_at=? WHERE id=?").run(stage, current.stage === "Archived" ? null : stage === "Archived" ? current.stage : current.archived_from_stage ?? null, now, id);
  return getJobDetail(db, id);
}

export function archiveJob(db: DatabaseSync, id: string, now = new Date().toISOString()) {
  const current = ensureJob(db, id);
  if (current.stage === "Archived") return getJobDetail(db, id);
  db.prepare("UPDATE jobs SET stage='Archived',archived_from_stage=?,updated_at=? WHERE id=?").run(current.stage, now, id);
  return getJobDetail(db, id);
}

export function restoreJob(db: DatabaseSync, id: string, now = new Date().toISOString()) {
  const current = ensureJob(db, id);
  if (current.stage !== "Archived") throw Object.assign(new Error("Only archived jobs can be restored."), { statusCode: 409 });
  const stage = current.archived_from_stage ?? "Recommended";
  db.prepare("UPDATE jobs SET stage=?,archived_from_stage=NULL,updated_at=? WHERE id=?").run(stage, now, id);
  return getJobDetail(db, id);
}

export function updateJob(db: DatabaseSync, id: string, value: { notes?: string; stage?: JobStage; applicationNotes?: string }, now = new Date().toISOString()) {
  const current = ensureJob(db, id);
  if (value.stage) setJobStage(db, id, value.stage, now);
  db.prepare("UPDATE jobs SET notes=COALESCE(?,notes),updated_at=? WHERE id=?").run(value.notes ?? null, now, id);
  if (value.applicationNotes !== undefined) {
    db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(id, now);
    db.prepare("UPDATE applications SET notes=?,updated_at=? WHERE job_id=?").run(value.applicationNotes, now, id);
  }
  return getJobDetail(db, id);
}

export function updateJobDirection(db: DatabaseSync, id: string, patch: Partial<GenerationDirection>, now = new Date().toISOString()) {
  const current = ensureJob(db, id);
  if (current.stage !== "Selected" && current.stage !== "Drafting" && current.stage !== "Ready") {
    throw Object.assign(new Error("Direction can only be updated for Selected, Drafting, or Ready jobs."), { statusCode: 409 });
  }
  const existing = db.prepare("SELECT generation_direction_json FROM applications WHERE job_id=?").get(id) as { generation_direction_json?: string } | undefined;
  const next = { ...parseGenerationDirection(existing?.generation_direction_json), ...patch };
  db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(id, now);
  db.prepare("UPDATE applications SET generation_direction_json=?,updated_at=? WHERE job_id=?").run(JSON.stringify(next), now, id);
  return getJobDetail(db, id);
}

export function toggleSelection(db: DatabaseSync, id: string) {
  const row = ensureJob(db, id);
  if (row.stage !== "Recommended" && row.stage !== "Selected") throw Object.assign(new Error("Only Recommended jobs can be selected."), { statusCode: 409 });
  return setJobStage(db, id, row.stage === "Recommended" ? "Selected" : "Recommended");
}

export function approveApplication(db: DatabaseSync, id: string, now = new Date().toISOString()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT j.stage,a.verification_json FROM jobs j LEFT JOIN applications a ON a.job_id=j.id WHERE j.id=?").get(id) as { stage: string; verification_json: string | null } | undefined;
    if (!row) throw Object.assign(new Error("Job not found."), { statusCode: 404 });
    if (row.stage !== "Drafting") throw Object.assign(new Error("Only Drafting jobs may be approved."), { statusCode: 409 });
    if (jsonValue<{ success?: boolean } | null>(row.verification_json, null)?.success !== true) throw Object.assign(new Error("Successful document verification is required."), { statusCode: 409 });
    db.prepare("UPDATE applications SET approved_at=?,updated_at=? WHERE job_id=?").run(now, now, id);
    db.prepare("UPDATE jobs SET stage='Ready',updated_at=? WHERE id=?").run(now, id);
    db.exec("COMMIT");
    return getJobDetail(db, id);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markApplied(db: DatabaseSync, id: string, value: { submittedAt: string; channel: string; notes: string }, now = new Date().toISOString()) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = ensureJob(db, id);
    if (row.stage !== "Ready") throw Object.assign(new Error("Only Ready jobs may be marked Applied."), { statusCode: 409 });
    db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(id, now);
    db.prepare("UPDATE applications SET submitted_at=?,submission_channel=?,notes=?,updated_at=? WHERE job_id=?").run(value.submittedAt, value.channel, value.notes, now, id);
    db.prepare("UPDATE jobs SET stage='Applied',updated_at=? WHERE id=?").run(now, id);
    db.exec("COMMIT");
    return getJobDetail(db, id);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getEligibleInterviewJobs(db: DatabaseSync) {
  return listJobs(db, ["Applied", "Interview"]);
}

export function saveInterviewNotes(db: DatabaseSync, id: string, notes: string, now = new Date().toISOString()) {
  const row = ensureJob(db, id);
  if (row.stage !== "Applied" && row.stage !== "Interview") throw Object.assign(new Error("Interview practice is only available for Applied or Interview jobs."), { statusCode: 409 });
  db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(id, now);
  db.prepare("UPDATE applications SET interview_notes=?,updated_at=? WHERE job_id=?").run(notes, now, id);
  return getJobDetail(db, id);
}

export function saveInterviewMessages(db: DatabaseSync, id: string, messages: InterviewMessage[], now = new Date().toISOString()) {
  const row = ensureJob(db, id);
  if (row.stage !== "Applied" && row.stage !== "Interview") throw Object.assign(new Error("Interview practice is only available for Applied or Interview jobs."), { statusCode: 409 });
  db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(id, now);
  db.prepare("UPDATE applications SET interview_chat_json=?,interview_updated_at=?,updated_at=? WHERE job_id=?").run(JSON.stringify(messages.slice(-40)), now, now, id);
  return getJobDetail(db, id);
}

export function resetInterview(db: DatabaseSync, id: string, now = new Date().toISOString()) {
  const row = ensureJob(db, id);
  if (row.stage !== "Applied" && row.stage !== "Interview") throw Object.assign(new Error("Interview practice is only available for Applied or Interview jobs."), { statusCode: 409 });
  db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(id, now);
  db.prepare("UPDATE applications SET interview_chat_json='[]',interview_updated_at=?,updated_at=? WHERE job_id=?").run(now, now, id);
  return getJobDetail(db, id);
}

export function saveFollowUpDraft(db: DatabaseSync, id: string, draft: string, context: FollowUpContext, dueAt: string | null, now = new Date().toISOString()) {
  const row = ensureJob(db, id);
  if (row.stage !== "Applied" && row.stage !== "Interview") throw Object.assign(new Error("Follow-up is only available for Applied or Interview jobs."), { statusCode: 409 });
  db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(id, now);
  db.prepare("UPDATE applications SET follow_up_draft=?,follow_up_context_json=?,follow_up_due_at=?,follow_up_sent_at=NULL,updated_at=? WHERE job_id=?").run(draft, JSON.stringify(context), dueAt, now, id);
  return getJobDetail(db, id);
}

export function updateFollowUpDraft(db: DatabaseSync, id: string, draft: string, now = new Date().toISOString()) {
  const row = ensureJob(db, id);
  if (row.stage !== "Applied" && row.stage !== "Interview") throw Object.assign(new Error("Follow-up is only available for Applied or Interview jobs."), { statusCode: 409 });
  db.prepare("UPDATE applications SET follow_up_draft=?,updated_at=? WHERE job_id=?").run(draft, now, id);
  return getJobDetail(db, id);
}

export function markFollowUpSent(db: DatabaseSync, id: string, now = new Date().toISOString()) {
  const row = ensureJob(db, id);
  if (row.stage !== "Applied" && row.stage !== "Interview") throw Object.assign(new Error("Follow-up is only available for Applied or Interview jobs."), { statusCode: 409 });
  const draft = db.prepare("SELECT follow_up_draft FROM applications WHERE job_id=?").get(id) as { follow_up_draft?: string } | undefined;
  if (!draft?.follow_up_draft?.trim()) throw Object.assign(new Error("Save a follow-up draft before marking it sent."), { statusCode: 409 });
  db.prepare("UPDATE applications SET follow_up_sent_at=?,updated_at=? WHERE job_id=?").run(now, now, id);
  return getJobDetail(db, id);
}

const trajectoryPayloadLimits = {
  system: 2_000_000,
  user: 2_000_000,
  assistant: 2_000_000,
  thinking: 2_000_000,
  tool_call: 250_000,
  tool_update: 250_000,
  tool_result: 250_000,
  lifecycle: 50_000,
  error: 50_000,
} as const;

function serializeTrajectoryPayload(value: unknown, limit: number) {
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === "bigint") return `${current}n`;
      if (current instanceof Error) return { name: current.name, message: current.message };
      if (current && typeof current === "object") {
        if (seen.has(current)) return "[Circular]";
        seen.add(current);
      }
      return current;
    }) ?? "null";
  } catch {
    serialized = JSON.stringify({ unserializable: true });
  }
  serialized = serialized
    .replace(/(https?:\/\/)([^/\s:@]+)(?::[^/\s@]*)?@/gi, "$1[redacted]@")
    .replace(/(authorization\s*[:=]\s*bearer\s+|bearer\s+)[^\s,}]+/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|apikey|token|secret|password|authorization|access_token)=)[^&\s]*/gi, "$1[redacted]")
    .replace(/([\"']?(?:api[_-]?key|apikey|token|secret|password|authorization|bearer)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,}]+/gi, "$1[redacted]");
  if (serialized.length <= limit) return serialized;
  return JSON.stringify({ truncated: true, preview: serialized.slice(0, limit), originalChars: serialized.length });
}

export function appendRunTrajectoryEvent(db: DatabaseSync, runId: string, input: TrajectoryEventInput): TrajectoryEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const startedAt = input.startedAt ?? null;
  const endedAt = input.endedAt ?? null;
  const durationMs = input.durationMs !== undefined && input.durationMs !== null && Number.isFinite(input.durationMs) ? input.durationMs : null;
  const sequence = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_trajectory_events WHERE run_id=?").get(runId) as { next: number }).next);
  db.prepare("INSERT INTO run_trajectory_events(run_id,sequence,kind,event_type,timestamp,started_at,ended_at,duration_ms,payload_json) VALUES(?,?,?,?,?,?,?,?,?)").run(runId, sequence, input.kind, input.type, timestamp, startedAt, endedAt, durationMs, serializeTrajectoryPayload(input.payload ?? null, trajectoryPayloadLimits[input.kind]));
  const row = db.prepare("SELECT payload_json FROM run_trajectory_events WHERE run_id=? AND sequence=?").get(runId, sequence) as { payload_json?: string } | undefined;
  return { runId, sequence, kind: input.kind, type: input.type, timestamp, startedAt, endedAt, durationMs, payload: jsonValue(row?.payload_json, null) } as TrajectoryEvent;
}

export function listRunTrajectoryEvents(db: DatabaseSync, runId: string): TrajectoryEvent[] {
  return (db.prepare("SELECT run_id,sequence,kind,event_type,timestamp,started_at,ended_at,duration_ms,payload_json FROM run_trajectory_events WHERE run_id=? ORDER BY sequence ASC").all(runId) as Array<Record<string, unknown>>).map((row) => ({
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    kind: row.kind,
    type: row.event_type,
    timestamp: String(row.timestamp),
    startedAt: row.started_at ? String(row.started_at) : null,
    endedAt: row.ended_at ? String(row.ended_at) : null,
    durationMs: typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) ? row.duration_ms : null,
    payload: jsonValue(row.payload_json, null),
  })) as TrajectoryEvent[];
}

export function createTrajectoryRecorder(db: DatabaseSync): TrajectoryRecorder {
  return (runId, event) => {
    try { appendRunTrajectoryEvent(db, runId, event); } catch { /* telemetry is deliberately non-fatal */ }
  };
}

export type TaskDescriptor = Pick<TaskEventPayload, "taskId" | "label" | "detail">;
export type TaskReporter = {
  start: (task: TaskDescriptor) => void;
  complete: (taskId: string, detail?: string) => void;
  fail: (taskId: string, detail?: string) => void;
  failActive: (detail?: string) => void;
};

function taskText(value: string | undefined, limit: number) {
  return value?.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) || undefined;
}

export function recordTaskEvent(trajectory: TrajectoryRecorder | undefined, runId: string | undefined, task: TaskEventPayload, timing: Pick<TrajectoryEventInput, "timestamp" | "startedAt" | "endedAt" | "durationMs"> = {}) {
  if (!runId) return;
  try {
    trajectory?.(runId, {
      kind: "lifecycle",
      type: `task_${task.status}`,
      timestamp: timing.timestamp ?? new Date().toISOString(),
      startedAt: timing.startedAt,
      endedAt: timing.endedAt,
      durationMs: timing.durationMs,
      payload: task,
    });
  } catch { /* telemetry is deliberately non-fatal */ }
}

export function createTaskReporter(trajectory: TrajectoryRecorder | undefined, runId?: string): TaskReporter {
  const active = new Map<string, { task: TaskDescriptor; startedAt: string; attempt: number }>();
  const attempts = new Map<string, number>();
  const emit = (task: TaskEventPayload, timing: Pick<TrajectoryEventInput, "timestamp" | "startedAt" | "endedAt" | "durationMs">) => recordTaskEvent(trajectory, runId, task, timing);
  const finish = (taskId: string, status: "completed" | "failed", detail?: string) => {
    const current = active.get(taskId);
    if (!current) return;
    const endedAt = new Date().toISOString();
    const durationMs = Date.parse(endedAt) - Date.parse(current.startedAt);
    active.delete(taskId);
    emit({ ...current.task, detail: taskText(detail, 320) ?? current.task.detail, status, attempt: current.attempt }, { timestamp: endedAt, startedAt: current.startedAt, endedAt, durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null });
  };
  return {
    start(task) {
      const normalized: TaskDescriptor = { taskId: taskText(task.taskId, 180) ?? "task", label: taskText(task.label, 180) ?? "Workflow task", detail: taskText(task.detail, 320) };
      const startedAt = new Date().toISOString();
      const attempt = (attempts.get(normalized.taskId) ?? 0) + 1;
      attempts.set(normalized.taskId, attempt);
      active.set(normalized.taskId, { task: normalized, startedAt, attempt });
      emit({ ...normalized, status: "started", attempt }, { timestamp: startedAt, startedAt });
    },
    complete(taskId, detail) { finish(taskId, "completed", detail); },
    fail(taskId, detail) { finish(taskId, "failed", detail); },
    failActive(detail) { for (const taskId of [...active.keys()]) finish(taskId, "failed", detail); },
  };
}

function mapRun(row: Record<string, unknown>): Run {
  const { summary_json: _summaryJson, ...value } = row;
  return { ...value, summary: jsonValue(row.summary_json, null) } as unknown as Run;
}

export function listRuns(db: DatabaseSync, limit = 50): Run[] {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return (db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(safeLimit) as Array<Record<string, unknown>>).map(mapRun);
}

export function getActiveRun(db: DatabaseSync) {
  const row = db.prepare("SELECT * FROM runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function getRun(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : undefined;
}
