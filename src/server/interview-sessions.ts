import { createHash } from "node:crypto";
import type { Settings } from "./config.js";
import {
  PiRunCancelledError,
  runBoundedPi,
  type PiRunUsage,
  type PiSessionLike,
} from "./pi.js";
import type { TrajectoryRecorder } from "../shared.js";

// ponytail: session pool max 8 jobs with 15-minute TTL; raise after heap and provider-session measurements.
const defaultMaxEntries = 8;
const defaultTtlMs = 15 * 60 * 1000;
const defaultSweepIntervalMs = 60 * 1000;
const defaultTimeoutMs = 120 * 1000;
const defaultInactivityTimeoutMs = 120 * 1000;

export type InterviewSessionFactory = (input: {
  jobId: string;
  systemPrompt: string;
  settings: Settings;
}) => PiSessionLike | Promise<PiSessionLike>;

export type InterviewSessionRun = {
  jobId: string;
  systemPrompt: string;
  prompt: string;
  rebuildPrompt: string;
  settings: Settings;
  signal: AbortSignal;
  runId?: string;
  trajectory?: TrajectoryRecorder;
  onDelta?: (fullText: string) => void;
  onUsage?: (usage: PiRunUsage) => void;
};

export type InterviewSessionPoolOptions = {
  createSession: InterviewSessionFactory;
  maxEntries?: number;
  maxSessions?: number;
  ttlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  timeoutMs?: number;
  inactivityTimeoutMs?: number;
};

type PooledSession = {
  session: PiSessionLike;
  lastUsedAt: number;
  systemPromptHash: string;
};

type ActiveRun = {
  jobId: string;
  entry: PooledSession;
  adapter: PooledSessionAdapter;
  controller: AbortController;
  finished: Promise<void>;
  finish: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function textDelta(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (event.type === "text_delta" && typeof event.delta === "string") return event.delta;
  if (event.type !== "message_update" || !isRecord(event.assistantMessageEvent)) return undefined;
  return event.assistantMessageEvent.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string"
    ? event.assistantMessageEvent.delta
    : undefined;
}

function systemPromptHash(systemPrompt: string, settings: Settings) {
  return createHash("sha256").update(JSON.stringify({
    systemPrompt,
    provider: settings.provider,
    model: settings.model,
  })).digest("hex");
}

function positiveInteger(value: number | undefined, fallback: number, label: string) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new Error(`${label} must be a positive integer.`);
  return result;
}

function safeDispose(session: PiSessionLike) {
  try { session.dispose(); } catch { /* preserve the original pool outcome */ }
}

class PooledSessionAdapter implements PiSessionLike {
  private readonly unsubscriptions = new Set<() => void>();
  private abortPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly pooled: PiSessionLike) {}

  get systemPrompt() { return this.pooled.systemPrompt; }
  get model() { return this.pooled.model; }

  getActiveToolNames() {
    return this.pooled.getActiveToolNames?.() ?? [];
  }

  getAllTools() {
    return this.pooled.getAllTools?.() ?? [];
  }

  subscribe(listener: (event: unknown) => void) {
    let active = true;
    const unsubscribePooled = this.pooled.subscribe((event) => {
      if (active && !this.disposed) listener(event);
    });
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.unsubscriptions.delete(unsubscribe);
      try { unsubscribePooled(); } catch { /* listener cleanup is best effort */ }
    };
    this.unsubscriptions.add(unsubscribe);
    return unsubscribe;
  }

  prompt(text: string) {
    if (this.disposed) return Promise.reject(new Error("Session adapter is disposed."));
    return this.pooled.prompt(text);
  }

  abort() {
    this.abortPromise ??= Promise.resolve().then(() => this.pooled.abort());
    return this.abortPromise;
  }

  waitForAbort() {
    return this.abortPromise ?? Promise.resolve();
  }

  dispose() {
    this.disposed = true;
    for (const unsubscribe of [...this.unsubscriptions]) unsubscribe();
    // runBoundedPi owns this adapter, while the pool owns the underlying session.
  }
}

export class InterviewSessionPool {
  private readonly sessions = new Map<string, PooledSession>();
  private readonly inUse = new Set<PooledSession>();
  private readonly discarded = new Set<PooledSession>();
  private readonly disposed = new WeakSet<PooledSession>();
  private readonly activeRuns = new Set<ActiveRun>();
  private readonly jobTails = new Map<string, Promise<void>>();
  private creating = 0;
  private readonly createSession: InterviewSessionFactory;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly inactivityTimeoutMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: InterviewSessionPoolOptions) {
    this.createSession = options.createSession;
    this.maxEntries = positiveInteger(options.maxEntries ?? options.maxSessions, defaultMaxEntries, "maxEntries");
    this.ttlMs = positiveInteger(options.ttlMs, defaultTtlMs, "ttlMs");
    const sweepIntervalMs = positiveInteger(options.sweepIntervalMs, Math.min(defaultSweepIntervalMs, this.ttlMs), "sweepIntervalMs");
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = positiveInteger(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
    this.inactivityTimeoutMs = positiveInteger(options.inactivityTimeoutMs, defaultInactivityTimeoutMs, "inactivityTimeoutMs");
    this.sweepTimer = setInterval(() => { this.pruneExpired(); }, sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  size() {
    return this.sessions.size;
  }

  has(jobId: string) {
    return this.sessions.has(jobId);
  }

  pruneExpired() {
    if (this.closed) return 0;
    const now = this.now();
    let removed = 0;
    for (const [jobId, entry] of this.sessions) {
      if (this.inUse.has(entry) || now - entry.lastUsedAt < this.ttlMs) continue;
      this.sessions.delete(jobId);
      this.discarded.add(entry);
      this.disposeWhenIdle(entry);
      removed += 1;
    }
    return removed;
  }

  async run(input: InterviewSessionRun) {
    if (this.closed) throw new Error("Interview session pool is closed.");
    const previous = this.jobTails.get(input.jobId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.jobTails.set(input.jobId, tail);
    try {
      await this.waitForTurn(previous, input.signal);
      if (this.closed) throw new Error("Interview session pool is closed.");
      return await this.runTurn(input);
    } finally {
      release();
      if (this.jobTails.get(input.jobId) === tail) this.jobTails.delete(input.jobId);
    }
  }

  async invalidate(jobId: string) {
    const entries = new Set<PooledSession>();
    const mapped = this.sessions.get(jobId);
    if (mapped) entries.add(mapped);
    for (const active of this.activeRuns) if (active.jobId === jobId) entries.add(active.entry);
    if (!entries.size) return false;

    for (const entry of entries) {
      if (this.sessions.get(jobId) === entry) this.sessions.delete(jobId);
      this.discarded.add(entry);
    }
    const active = [...this.activeRuns].filter((run) => run.jobId === jobId && entries.has(run.entry));
    for (const run of active) run.controller.abort();
    await Promise.allSettled(active.map((run) => run.finished));
    for (const entry of entries) this.disposeWhenIdle(entry);
    return true;
  }

  async discard(jobId: string) {
    return this.invalidate(jobId);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  async dispose() {
    return this.close();
  }

  private async finishClose() {
    const entries = new Set<PooledSession>([
      ...this.sessions.values(),
      ...[...this.activeRuns].map((run) => run.entry),
    ]);
    for (const [jobId, entry] of this.sessions) {
      this.sessions.delete(jobId);
      this.discarded.add(entry);
    }
    for (const entry of entries) this.discarded.add(entry);
    const active = [...this.activeRuns];
    for (const run of active) run.controller.abort();
    await Promise.allSettled(active.map((run) => run.finished));
    for (const entry of entries) this.disposeWhenIdle(entry);
    this.sessions.clear();
    this.inUse.clear();
    this.discarded.clear();
    this.activeRuns.clear();
    this.jobTails.clear();
  }

  private async waitForTurn(previous: Promise<void>, signal: AbortSignal) {
    if (signal.aborted) throw new PiRunCancelledError();
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new PiRunCancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([previous, cancelled]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async runTurn(input: InterviewSessionRun) {
    if (input.signal.aborted) throw new PiRunCancelledError();
    const hash = systemPromptHash(input.systemPrompt, input.settings);
    const { entry, rebuild } = await this.acquire(input, hash);
    const adapter = new PooledSessionAdapter(entry.session);
    const controller = new AbortController();
    const active = this.trackRun(input.jobId, entry, adapter, controller);
    const onInputAbort = () => controller.abort();
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener("abort", onInputAbort, { once: true });

    let succeeded = false;
    let text = "";
    try {
      await runBoundedPi({
        prompt: rebuild ? input.rebuildPrompt : input.prompt,
        timeoutMs: this.timeoutMs,
        inactivityTimeoutMs: this.inactivityTimeoutMs,
        signal: controller.signal,
        createSession: async () => adapter,
        settings: input.settings,
        guidance: input.systemPrompt,
        runId: input.runId,
        trajectory: input.trajectory,
        onUsage: input.onUsage,
        onEvent: (event) => {
          const delta = textDelta(event);
          if (delta === undefined) return;
          text += delta;
          try { input.onDelta?.(text); } catch { /* streaming is deliberately non-fatal */ }
        },
      });
      if (controller.signal.aborted) throw new PiRunCancelledError();
      const result = text.trim();
      if (!result) throw new Error("Provider returned an empty response.");
      succeeded = true;
      return result;
    } catch (error) {
      await this.discardAfterFailure(input.jobId, entry, adapter);
      throw error;
    } finally {
      input.signal.removeEventListener("abort", onInputAbort);
      if (succeeded) this.releaseAfterSuccess(input.jobId, entry);
      this.activeRuns.delete(active);
      active.finish();
    }
  }

  private async acquire(input: InterviewSessionRun, hash: string) {
    this.pruneExpired();
    const existing = this.sessions.get(input.jobId);
    if (existing && existing.systemPromptHash === hash && !this.discarded.has(existing)) {
      this.inUse.add(existing);
      return { entry: existing, rebuild: false };
    }
    if (existing) this.retire(input.jobId, existing);

    while (this.sessions.size + this.creating >= this.maxEntries) {
      if (!this.evictOldestIdle()) throw new Error("Interview session pool is full.");
    }
    this.creating += 1;
    let session: PiSessionLike;
    try {
      session = await this.createSession({
        jobId: input.jobId,
        systemPrompt: input.systemPrompt,
        settings: input.settings,
      });
    } finally {
      this.creating -= 1;
    }
    if (this.closed) {
      safeDispose(session);
      throw new Error("Interview session pool is closed.");
    }
    if (input.signal.aborted) {
      safeDispose(session);
      throw new PiRunCancelledError();
    }
    const entry: PooledSession = {
      session,
      lastUsedAt: this.now(),
      systemPromptHash: hash,
    };
    this.sessions.set(input.jobId, entry);
    this.inUse.add(entry);
    return { entry, rebuild: true };
  }

  private trackRun(jobId: string, entry: PooledSession, adapter: PooledSessionAdapter, controller: AbortController) {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const active: ActiveRun = { jobId, entry, adapter, controller, finished, finish };
    this.activeRuns.add(active);
    return active;
  }

  private async discardAfterFailure(jobId: string, entry: PooledSession, adapter: PooledSessionAdapter) {
    if (this.sessions.get(jobId) === entry) this.sessions.delete(jobId);
    this.discarded.add(entry);
    try { await adapter.waitForAbort(); } catch { /* preserve the original run outcome */ }
    this.inUse.delete(entry);
    this.disposeWhenIdle(entry);
  }

  private releaseAfterSuccess(jobId: string, entry: PooledSession) {
    this.inUse.delete(entry);
    if (this.closed || this.discarded.has(entry) || this.sessions.get(jobId) !== entry) {
      this.disposeWhenIdle(entry);
      return;
    }
    entry.lastUsedAt = this.now();
    this.evictIdle();
  }

  private retire(jobId: string, entry: PooledSession) {
    if (this.sessions.get(jobId) === entry) this.sessions.delete(jobId);
    this.discarded.add(entry);
    this.disposeWhenIdle(entry);
  }

  private disposeWhenIdle(entry: PooledSession) {
    if (this.inUse.has(entry) || this.disposed.has(entry)) return;
    this.disposed.add(entry);
    safeDispose(entry.session);
    this.discarded.delete(entry);
  }

  private evictIdle() {
    while (this.sessions.size > this.maxEntries) {
      if (!this.evictOldestIdle()) return;
    }
  }

  private evictOldestIdle() {
    let oldestJobId: string | undefined;
    let oldest: PooledSession | undefined;
    for (const [jobId, entry] of this.sessions) {
      if (this.inUse.has(entry) || this.discarded.has(entry)) continue;
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
        oldestJobId = jobId;
        oldest = entry;
      }
    }
    if (!oldest || oldestJobId === undefined) return false;
    this.sessions.delete(oldestJobId);
    this.discarded.add(oldest);
    this.disposeWhenIdle(oldest);
    return true;
  }
}
