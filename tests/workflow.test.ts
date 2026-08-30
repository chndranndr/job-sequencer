import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, markFollowUpSent, resetInterview, saveFollowUpDraft, saveInterviewMessages, saveInterviewNotes } from "../src/server/db.js";
import { buildServer } from "../src/server/app.js";
import { containedPath } from "../src/server/documents.js";
import type { InterviewExecutor } from "../src/server/interview.js";
import type { PiSessionLike } from "../src/server/pi.js";

function insert(db: ReturnType<typeof openDatabase>, stage: "Applied" | "Interview" = "Applied") {
  const id = randomUUID();
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, id, "freehire", `https://example.test/${id}`, "Example", "Engineer", "Posting", 81, JSON.stringify({ reason: "fit", strengths: [], gaps: [] }), stage, "2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
  return id;
}

async function waitForRun(app: Awaited<ReturnType<typeof buildServer>>, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = (await app.inject({ url: `/api/runs/${id}` })).json() as { status: string };
    if (run.status !== "running" && run.status !== "queued") return run;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("run did not finish");
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

test("interview practice persists notes/messages without changing stage and reset keeps notes", () => {
  const db = openDatabase(":memory:");
  try {
    const id = insert(db, "Applied");
    saveInterviewNotes(db, id, "Real interview on 20 Aug.");
    saveInterviewMessages(db, id, [{ role: "assistant", content: "Tell me about a system you changed.", createdAt: "2026-08-12T00:00:00.000Z" }]);
    assert.equal((db.prepare("SELECT stage,interview_notes,interview_chat_json FROM jobs j JOIN applications a ON a.job_id=j.id WHERE j.id=?").get(id) as { stage: string; interview_notes: string; interview_chat_json: string }).stage, "Applied");
    resetInterview(db, id);
    const row = db.prepare("SELECT j.stage,a.interview_notes,a.interview_chat_json FROM jobs j JOIN applications a ON a.job_id=j.id WHERE j.id=?").get(id) as { stage: string; interview_notes: string; interview_chat_json: string };
    assert.equal(row.stage, "Applied"); assert.equal(row.interview_notes, "Real interview on 20 Aug."); assert.deepEqual(JSON.parse(row.interview_chat_json), []);
  } finally { db.close(); }
});

test("interview API passes exact current documents and bounded history without changing stage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-interview-"));
  const db = openDatabase(":memory:");
  const id = insert(db, "Applied");
  const missingDocumentsId = insert(db, "Applied");
  const currentDir = containedPath(dir, "applications", id, "current");
  const cv = "\\documentclass{article}\nExact CV fixture\n";
  const coverLetter = "\\documentclass{letter}\nExact cover-letter fixture\n";
  const contexts: Array<Parameters<InterviewExecutor>[0]> = [];
  await mkdir(currentDir, { recursive: true });
  await writeFile(containedPath(currentDir, "cv.tex"), cv, "utf8");
  await writeFile(containedPath(currentDir, "cover-letter.tex"), coverLetter, "utf8");
  const app = await buildServer({
    dataDir: dir,
    db,
    interviewExecutor: async (context) => {
      contexts.push(context);
      return `answer-${contexts.length}`;
    },
  });
  try {
    const turns = [
      { message: "Tell me about your backend work.", focus: "backend" },
      { message: "How did you handle the tradeoff?", focus: "tradeoffs" },
      { message: "What would you improve next?", focus: "reflection" },
    ];
    for (const [index, payload] of turns.entries()) {
      const response = await app.inject({ method: "POST", url: `/api/jobs/${id}/interview`, payload });
      assert.equal(response.statusCode, 202);
      assert.equal((await waitForRun(app, response.json().runId)).status, "succeeded");
      const job = (await app.inject({ url: `/api/jobs/${id}` })).json();
      assert.equal(job.stage, "Applied");
      assert.equal(job.interview_messages.length, (index + 1) * 2);
    }

    assert.equal(contexts.length, 3);
    assert.deepEqual(contexts.map((context) => ({
      documents: context.documents,
      focus: context.focus,
      messages: context.messages.map(({ role, content }) => ({ role, content })),
    })), [
      { documents: { cv, coverLetter }, focus: "backend", messages: [] },
      { documents: { cv, coverLetter }, focus: "tradeoffs", messages: [
        { role: "user", content: turns[0].message },
        { role: "assistant", content: "answer-1" },
      ] },
      { documents: { cv, coverLetter }, focus: "reflection", messages: [
        { role: "user", content: turns[0].message },
        { role: "assistant", content: "answer-1" },
        { role: "user", content: turns[1].message },
        { role: "assistant", content: "answer-2" },
      ] },
    ]);

    const missingResponse = await app.inject({ method: "POST", url: `/api/jobs/${missingDocumentsId}/interview`, payload: { message: "Start without documents." } });
    assert.equal(missingResponse.statusCode, 202);
    assert.equal((await waitForRun(app, missingResponse.json().runId)).status, "succeeded");
    assert.deepEqual(contexts[3]?.documents, { cv: null, coverLetter: null });
    assert.equal((await app.inject({ url: `/api/jobs/${missingDocumentsId}` })).json().stage, "Applied");
  } finally {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("interview stream endpoint streams live interviewer text and closes on done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-interview-stream-"));
  const db = openDatabase(":memory:");
  const id = insert(db, "Applied");
  const app = await buildServer({
    dataDir: dir,
    db,
    interviewExecutor: async (context) => {
      context.onDelta?.("Hello");
      await new Promise((resolve) => setTimeout(resolve, 150));
      context.onDelta?.("Hello from the other side of the table.");
      return "Hello from the other side of the table.";
    },
  });
  try {
    const started = await app.inject({ method: "POST", url: `/api/jobs/${id}/interview`, payload: { message: "Please begin." } });
    assert.equal(started.statusCode, 202);
    const runId = started.json().runId;
    const streamResponse = await app.inject({ url: `/api/jobs/${id}/interview/stream?runId=${encodeURIComponent(runId)}` });
    assert.equal(streamResponse.statusCode, 200);
    assert.match(String(streamResponse.headers["content-type"]), /text\/event-stream/);
    assert.ok(streamResponse.body.includes(JSON.stringify({ text: "Hello from the other side of the table." })), `stream body should carry the accumulated text, got: ${streamResponse.body}`);
    assert.match(streamResponse.body, /event: done/);
    assert.equal((await waitForRun(app, runId)).status, "succeeded");

    const unknownRun = await app.inject({ url: `/api/jobs/${id}/interview/stream?runId=does-not-exist` });
    assert.equal(unknownRun.statusCode, 404);
    const consumed = await app.inject({ url: `/api/jobs/${id}/interview/stream?runId=${encodeURIComponent(runId)}` });
    assert.equal(consumed.statusCode, 404);

    const job = (await app.inject({ url: `/api/jobs/${id}` })).json();
    assert.deepEqual(job.interview_messages.map(({ role, content }: { role: string; content: string }) => content), ["Please begin.", "Hello from the other side of the table."]);
  } finally {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pooled live interview keeps native sessions and SSE deltas across turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-interview-pooled-stream-"));
  const db = openDatabase(":memory:");
  const id = insert(db, "Applied");
  const sessions: Array<{ promptTexts: string[]; disposed: boolean }> = [];
  const app = await buildServer({
    dataDir: dir,
    db,
    interviewSessionFactory: async ({ systemPrompt }) => {
      const state = { promptTexts: [] as string[], disposed: false };
      const listeners = new Set<(event: unknown) => void>();
      const session: PiSessionLike = {
        systemPrompt,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        async prompt(text) {
          state.promptTexts.push(text);
          const message = { role: "assistant", timestamp: state.promptTexts.length, content: [] };
          for (const listener of listeners) listener({
            type: "message_update",
            message,
            assistantMessageEvent: { type: "text_delta", delta: "Pooled response" },
          });
        },
        async abort() {},
        dispose() { state.disposed = true; },
      };
      sessions.push(state);
      return session;
    },
  });
  try {
    const first = await app.inject({ method: "POST", url: `/api/jobs/${id}/interview`, payload: { message: "First answer.", focus: "opening" } });
    assert.equal(first.statusCode, 202);
    const firstRunId = first.json().runId;
    const firstStream = await app.inject({ url: `/api/jobs/${id}/interview/stream?runId=${encodeURIComponent(firstRunId)}` });
    assert.equal(firstStream.statusCode, 200);
    assert.ok(firstStream.body.includes(JSON.stringify({ text: "Pooled response" })));
    assert.match(firstStream.body, /event: done/);
    assert.equal((await waitForRun(app, firstRunId)).status, "succeeded");

    const second = await app.inject({ method: "POST", url: `/api/jobs/${id}/interview`, payload: { message: "Second answer.", focus: "tradeoffs" } });
    assert.equal(second.statusCode, 202);
    assert.equal((await waitForRun(app, second.json().runId)).status, "succeeded");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.promptTexts.length, 2);
    assert.equal((await app.inject({ url: `/api/jobs/${id}` })).json().interview_messages.length, 4);

    const reset = await app.inject({ method: "DELETE", url: `/api/jobs/${id}/interview` });
    assert.equal(reset.statusCode, 200);
    const third = await app.inject({ method: "POST", url: `/api/jobs/${id}/interview`, payload: { message: "After reset.", focus: "restart" } });
    assert.equal(third.statusCode, 202);
    assert.equal((await waitForRun(app, third.json().runId)).status, "succeeded");
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.disposed, true);
    assert.equal((await app.inject({ url: `/api/jobs/${id}` })).json().interview_messages.length, 2);
  } finally {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
    assert.equal(sessions[0]?.disposed, true);
  }
});

test("concurrent interview submissions serialize message writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-interview-concurrent-"));
  const db = openDatabase(":memory:");
  const id = insert(db, "Applied");
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let calls = 0;
  const app = await buildServer({
    dataDir: dir,
    db,
    interviewExecutor: async ({ message }) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return `answer-${message}`;
    },
  });
  try {
    const first = await app.inject({ method: "POST", url: `/api/jobs/${id}/interview`, payload: { message: "first turn" } });
    assert.equal(first.statusCode, 202);
    await firstStarted.promise;
    const second = await app.inject({ method: "POST", url: `/api/jobs/${id}/interview`, payload: { message: "second turn" } });
    assert.equal(second.statusCode, 202);
    assert.equal((await app.inject({ url: `/api/runs/${second.json().runId}` })).json().status, "queued");

    releaseFirst.resolve();
    assert.equal((await waitForRun(app, first.json().runId)).status, "succeeded");
    assert.equal((await waitForRun(app, second.json().runId)).status, "succeeded");
    const messages = (await app.inject({ url: `/api/jobs/${id}` })).json().interview_messages;
    assert.deepEqual(messages.map(({ role, content }: { role: string; content: string }) => `${role}:${content}`), [
      "user:first turn",
      "assistant:answer-first turn",
      "user:second turn",
      "assistant:answer-second turn",
    ]);
  } finally {
    await app.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("follow-up requires a saved draft and marking sent never changes stage", () => {
  const db = openDatabase(":memory:");
  try {
    const id = insert(db, "Interview");
    assert.throws(() => markFollowUpSent(db, id), /Save a follow-up draft/);
    saveFollowUpDraft(db, id, "Thank you for the conversation.", { purpose: "Thank interviewer", recipient: "Hiring manager", context: "System design discussion", tone: "Professional" }, null);
    const updated = markFollowUpSent(db, id);
    assert.equal(updated?.stage, "Interview");
    assert.ok(updated?.follow_up_sent_at);
  } finally { db.close(); }
});
