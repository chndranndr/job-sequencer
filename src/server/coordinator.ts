import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  cleanupStaleRuns,
  finishRun,
  getRun,
  insertRun,
  markRunRunning,
  reconcileQueuedRuns,
  updateRunUsage,
  type RunUsage,
} from "./db.js";
import { classifyPiError, PiRunCancelledError, PiRunTimeoutError, type PiRunUsage } from "./pi.js";
import type { RunStatus, RunWorkflow, TrajectoryEventInput, TrajectoryRecorder } from "../shared.js";

export type TerminalRunStatus = Exclude<RunStatus, "queued" | "running">;

export type RunExecutionContext = {
  runId: string;
  signal: AbortSignal;
  onUsage: (usage: PiRunUsage) => void;
};

export type RunFailure = {
  status?: TerminalRunStatus;
  summary?: unknown;
  error?: string | null;
  errorCode?: string | null;
};

export type RunErrorContext = {
  runId: string;
  signal: AbortSignal;
};

export type RunTask<T = unknown> = {
  workflow: RunWorkflow;
  jobId?: string | null;
  jobIds?: readonly string[];
  provider: string;
  model: string;
  idempotencyKey?: string | null;
  execute: (context: RunExecutionContext) => Promise<T>;
  onError?: (error: unknown, context: RunErrorContext) => RunFailure | undefined;
};

export type RunCoordinatorOptions = {
  db: DatabaseSync;
  concurrency?: number;
  globalConcurrency?: number;
  sameJobPolicy?: "queue" | "reject";
  policy?: {
    globalConcurrency?: number;
    sameJob?: "queue" | "reject";
  };
  trajectory?: TrajectoryRecorder;
  now?: () => string;
  reconcileQueued?: boolean;
};

type QueueEntry = {
  id: string;
  task: RunTask<unknown>;
  resources: readonly string[];
  controller: AbortController;
};

export class RunCoordinatorCancelledError extends Error {
  constructor() {
    super("Run cancelled.");
    this.name = "RunCoordinatorCancelledError";
  }
}

const defaultConcurrency = 1;
const maxIdempotencyKeyLength = 200;

function normalizedIdempotencyKey(value: string | null | undefined) {
  if (value === null || value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxIdempotencyKeyLength) throw new Error(`Idempotency keys must be ${maxIdempotencyKeyLength} characters or fewer.`);
  return normalized;
}

function resourceIds(task: RunTask<unknown>) {
  const values = [...(task.jobIds ?? [])];
  if (task.jobId && !values.includes(task.jobId)) values.push(task.jobId);
  const unique = [...new Set(values)];
  if (unique.some((value) => !value || typeof value !== "string")) throw new Error("Run resources must be non-empty job IDs.");
  if (unique.length !== values.length) throw new Error("Duplicate job IDs are not allowed.");
  return unique;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Run failed.";
}

function inferredStatus(error: unknown, signal: AbortSignal): TerminalRunStatus {
  if (signal.aborted || error instanceof RunCoordinatorCancelledError || error instanceof PiRunCancelledError) return "cancelled";
  if (error instanceof PiRunTimeoutError || classifyPiError(error) === "timeout") return "timed_out";
  return "failed";
}

function inferredErrorCode(status: TerminalRunStatus, error: unknown) {
  if (status === "cancelled") return "cancelled";
  if (status === "timed_out") return "timeout";
  return classifyPiError(error);
}

function usageValue(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addUsage(current: RunUsage, next: PiRunUsage): RunUsage {
  const add = (left: number | null, right: number | null) => {
    const value = usageValue(right);
    return value === null ? left : (left ?? 0) + value;
  };
  return {
    inputTokens: add(current.inputTokens, next.inputTokens),
    outputTokens: add(current.outputTokens, next.outputTokens),
    totalTokens: add(current.totalTokens, next.totalTokens),
    estimatedCost: add(current.estimatedCost, next.estimatedCost),
  };
}

export class RunCoordinator {
  private readonly db: DatabaseSync;
  private readonly concurrency: number;
  private readonly sameJobPolicy: "queue" | "reject";
  private readonly trajectory?: TrajectoryRecorder;
  private readonly now: () => string;
  private readonly reconcileQueued: boolean;
  private readonly queue: QueueEntry[] = [];
  private readonly active = new Map<string, QueueEntry>();
  private readonly lockedJobs = new Set<string>();
  private readonly waiters = new Map<string, Array<(run: NonNullable<ReturnType<typeof getRun>>) => void>>();
  private readonly settled = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: RunCoordinatorOptions);
  constructor(db: DatabaseSync, options?: Omit<RunCoordinatorOptions, "db">);
  constructor(optionsOrDb: RunCoordinatorOptions | DatabaseSync, legacyOptions: Omit<RunCoordinatorOptions, "db"> = {}) {
    const options = "db" in optionsOrDb ? optionsOrDb : { ...legacyOptions, db: optionsOrDb };
    const configuredConcurrency = options.policy?.globalConcurrency ?? options.globalConcurrency ?? options.concurrency ?? defaultConcurrency;
    if (!Number.isInteger(configuredConcurrency) || configuredConcurrency < 1) throw new Error("Coordinator concurrency must be a positive integer.");
    this.db = options.db;
    this.concurrency = configuredConcurrency;
    this.sameJobPolicy = options.policy?.sameJob ?? options.sameJobPolicy ?? "queue";
    this.trajectory = options.trajectory;
    this.now = options.now ?? (() => new Date().toISOString());
    this.reconcileQueued = options.reconcileQueued ?? true;
    this.reconcile();
  }

  reconcile() {
    const now = this.now();
    const staleRunning = cleanupStaleRuns(this.db, now);
    const staleQueued = this.reconcileQueued ? reconcileQueuedRuns(this.db, now) : 0;
    return { staleRunning, staleQueued };
  }

  findByIdempotencyKey(key: string | null | undefined) {
    const normalized = normalizedIdempotencyKey(key);
    if (!normalized) return undefined;
    const row = this.db.prepare("SELECT id FROM runs WHERE idempotency_key=?").get(normalized) as { id?: string } | undefined;
    return row?.id;
  }

  get(id: string) {
    return getRun(this.db, id);
  }

  async waitForCompletion(id: string) {
    const current = this.get(id);
    if (!current) throw new Error("Run not found.");
    if (current.status !== "queued" && current.status !== "running") return current;
    return new Promise<NonNullable<ReturnType<typeof getRun>>>((resolve) => {
      const currentWaiters = this.waiters.get(id) ?? [];
      currentWaiters.push(resolve);
      this.waiters.set(id, currentWaiters);
    });
  }

  async wait(id: string) {
    return this.waitForCompletion(id);
  }

  queueSnapshot() {
    return this.queue.map((entry) => entry.id);
  }

  isRunActive(id: string) {
    return this.active.has(id);
  }

  isWorkflowActive(workflow: RunWorkflow) {
    const row = this.db.prepare("SELECT 1 FROM runs WHERE workflow=? AND status IN ('queued','running') LIMIT 1").get(workflow);
    return Boolean(row);
  }

  async enqueue<T>(task: RunTask<T>) {
    if (this.closed) throw new Error("Run coordinator is closed.");
    const idempotencyKey = normalizedIdempotencyKey(task.idempotencyKey);
    const existing = this.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing;

    const resources = resourceIds(task as RunTask<unknown>);
    if (this.sameJobPolicy === "reject" && resources.some((jobId) => this.resourceBusy(jobId))) {
      throw Object.assign(new Error("Another run for this job is already queued or active."), { statusCode: 409 });
    }

    const id = randomUUID();
    const startedAt = this.now();
    try {
      insertRun(this.db, {
        id,
        workflow: task.workflow,
        status: "queued",
        jobId: task.jobId ?? (resources.length === 1 ? resources[0] : null),
        provider: task.provider,
        model: task.model,
        startedAt,
        idempotencyKey,
      });
    } catch (error) {
      if (idempotencyKey) {
        const concurrent = this.findByIdempotencyKey(idempotencyKey);
        if (concurrent) return concurrent;
      }
      throw error;
    }

    const entry: QueueEntry = {
      id,
      task: task as RunTask<unknown>,
      resources,
      controller: new AbortController(),
    };
    this.queue.push(entry);
    this.record(id, {
      kind: "lifecycle",
      type: "run_queued",
      timestamp: startedAt,
      payload: { workflow: task.workflow, jobId: task.jobId ?? null, queuePosition: this.queue.length },
    });
    this.pump();
    return id;
  }

  async start<T>(task: RunTask<T>) {
    return this.enqueue(task);
  }

  async admit<T>(task: RunTask<T>) {
    return this.enqueue(task);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    while (this.queue.length) {
      const entry = this.queue.shift()!;
      this.terminal(entry.id, "cancelled", null, "Run cancelled before execution.", "cancelled");
    }
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.settled.values()]);
  }

  cancel(id: string) {
    const queuedIndex = this.queue.findIndex((entry) => entry.id === id);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.terminal(id, "cancelled", null, "Run cancelled before execution.", "cancelled");
      this.pump();
      return true;
    }
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      return true;
    }
    const row = this.db.prepare("SELECT status FROM runs WHERE id=?").get(id) as { status?: RunStatus } | undefined;
    if (row?.status === "queued") {
      this.terminal(id, "cancelled", null, "Run cancelled before execution.", "cancelled");
      return true;
    }
    return false;
  }

  private resourceBusy(jobId: string) {
    if (this.lockedJobs.has(jobId)) return true;
    return this.queue.some((entry) => entry.resources.includes(jobId));
  }

  private nextRunnableIndex() {
    if (this.active.size >= this.concurrency) return -1;
    return this.queue.findIndex((entry) => entry.resources.every((jobId) => !this.lockedJobs.has(jobId)));
  }

  private pump() {
    if (this.closed) return;
    while (this.active.size < this.concurrency) {
      const index = this.nextRunnableIndex();
      if (index < 0) return;
      const entry = this.queue.splice(index, 1)[0]!;
      if (!markRunRunning(this.db, entry.id)) continue;
      this.active.set(entry.id, entry);
      for (const jobId of entry.resources) this.lockedJobs.add(jobId);
      this.record(entry.id, {
        kind: "lifecycle",
        type: "run_started",
        timestamp: this.now(),
        payload: { workflow: entry.task.workflow, jobId: entry.task.jobId ?? null },
      });
      const settled = this.execute(entry);
      this.settled.set(entry.id, settled);
      void settled.then(() => this.settled.delete(entry.id), () => this.settled.delete(entry.id));
    }
  }

  private async execute(entry: QueueEntry) {
    let usage: RunUsage = { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null };
    const onUsage = (next: PiRunUsage) => {
      usage = addUsage(usage, next);
      try { updateRunUsage(this.db, entry.id, usage); } catch {}
    };
    try {
      const summary = await entry.task.execute({ runId: entry.id, signal: entry.controller.signal, onUsage });
      if (entry.controller.signal.aborted) throw new RunCoordinatorCancelledError();
      this.terminal(entry.id, "succeeded", summary, null, null);
    } catch (error) {
      const failure = this.failure(entry, error);
      this.terminal(entry.id, failure.status, failure.summary ?? null, failure.error ?? errorMessage(error), failure.errorCode ?? inferredErrorCode(failure.status, error));
    } finally {
      this.active.delete(entry.id);
      this.settled.delete(entry.id);
      for (const jobId of entry.resources) this.lockedJobs.delete(jobId);
      if (!this.closed) this.pump();
    }
  }

  private failure(entry: QueueEntry, error: unknown): Required<RunFailure> {
    const status = inferredStatus(error, entry.controller.signal);
    let custom: RunFailure | undefined;
    try {
      custom = entry.task.onError?.(error, { runId: entry.id, signal: entry.controller.signal });
    } catch {}
    return {
      status: custom?.status ?? status,
      summary: custom?.summary ?? null,
      error: custom?.error ?? errorMessage(error),
      errorCode: custom?.errorCode ?? inferredErrorCode(custom?.status ?? status, error),
    };
  }

  private terminal(id: string, status: TerminalRunStatus, summary: unknown, error: string | null, errorCode: string | null) {
    const changed = finishRun(this.db, id, status, summary, error, errorCode, this.now());
    if (!changed) return false;
    this.record(id, {
      kind: status === "failed" || status === "timed_out" ? "error" : "lifecycle",
      type: status === "succeeded" ? "run_completed" : `run_${status}`,
      timestamp: this.now(),
      payload: { status, error, errorCode },
    });
    const waiters = this.waiters.get(id);
    if (waiters) {
      this.waiters.delete(id);
      const run = this.get(id);
      if (run) for (const resolve of waiters) resolve(run);
    }
    return true;
  }

  private record(runId: string, event: TrajectoryEventInput) {
    try { this.trajectory?.(runId, event); } catch {}
  }
}
