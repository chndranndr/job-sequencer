import test from "node:test";
import assert from "node:assert/strict";
import { inboxAgeDays, rowHex, scoreToNote, scoreToSignal } from "../src/tracker/notes.js";
import { parseTrackerHash, trackerHref, orderTabLabel } from "../src/tracker/hash.js";

function signalJob(role: string, posting = "", rank = { reason: "", strengths: [] as string[], gaps: [] as string[] }) {
  return { role, posting, rank };
}

test("score maps monotonically from C-5 to C-6 and clamps the endpoints", () => {
  const chromatic = ["C-5", "C#5", "D-5", "D#5", "E-5", "F-5", "F#5", "G-5", "G#5", "A-5", "A#5", "B-5", "C-6"];
  let previous = -1;
  for (let score = 10; score <= 100; score++) {
    const current = chromatic.indexOf(scoreToNote(score));
    assert.ok(current >= previous, `score ${score} moved backwards`);
    previous = current;
  }
  assert.equal(scoreToNote(9), "C-5");
  assert.equal(scoreToNote(10), "C-5");
  assert.equal(scoreToNote(25), "D-5");
  assert.equal(scoreToNote(55), "F#5");
  assert.equal(scoreToNote(100), "C-6");
  assert.equal(scoreToNote(101), "C-6");
  assert.equal(scoreToNote(Number.NaN), "---");
  assert.equal(rowHex(0), "00");
  assert.equal(rowHex(15), "0F");
});

test("score signals use fixed keyword priority across role, posting, and rank text", () => {
  assert.equal(scoreToSignal(signalJob("Java Platform Engineer", "AWS cloud services")), "JVM");
  assert.equal(scoreToSignal(signalJob("Go Backend Engineer")), "GO");
  assert.equal(scoreToSignal(signalJob("Backend Engineer", "AWS cloud services")), "CLOUD");
  assert.equal(scoreToSignal(signalJob("Platform Engineer")), "PLAT");
  assert.equal(scoreToSignal(signalJob("Engineer", "LLM product")), "AI");
  assert.equal(scoreToSignal(signalJob("Engineer", "GraphQL services")), "API");
  assert.equal(scoreToSignal(signalJob("Engineer", "React application")), "UI");
  assert.equal(scoreToSignal(signalJob("Engineer", "", { reason: "Analytics fit", strengths: [], gaps: [] })), "DATA");
  assert.equal(scoreToSignal(signalJob("Engineer", "SQL warehouse")), "DATA");
  assert.equal(scoreToSignal(signalJob("Operations Specialist", "Customer operations", { reason: "General fit", strengths: [], gaps: [] })), "FIT");
  assert.equal(scoreToSignal(signalJob("Java Platform Engineer", "AWS cloud services")), scoreToSignal(signalJob("Java Platform Engineer", "AWS cloud services")));
});

test("inbox age is based on first-seen time and a deterministic now timestamp", () => {
  const now = Date.parse("2026-08-26T12:00:00.000Z");
  assert.equal(inboxAgeDays("2026-08-24T12:00:00.000Z", now), 2);
  assert.equal(inboxAgeDays("2026-08-27T00:00:00.000Z", now), 0);
  assert.equal(inboxAgeDays("not-a-timestamp", now), 0);
});

test("tracker hash routes stay on the tracker page and do not collide with legacy paths", () => {
  assert.deepEqual(parseTrackerHash("#/pattern"), { view: "pattern", jobId: undefined, orderFocus: undefined, mixFocus: undefined });
  assert.deepEqual(parseTrackerHash("#/sample/abc"), { view: "sample", jobId: "abc", orderFocus: undefined, mixFocus: undefined });
  assert.deepEqual(parseTrackerHash("#/mix/draft"), { view: "order", jobId: undefined, orderFocus: "draft", mixFocus: "draft" });
  assert.deepEqual(parseTrackerHash("#/order/ready"), { view: "order", jobId: undefined, orderFocus: "ready", mixFocus: "ready" });
  assert.deepEqual(parseTrackerHash("#/nope"), { view: "pattern", jobId: undefined, orderFocus: undefined, mixFocus: undefined });
  assert.equal(trackerHref("phrase", "job-1"), "#/phrase/job-1");
  assert.equal(trackerHref("order", undefined, "ready"), "#/order/ready");
  assert.equal(orderTabLabel("order"), "ORDER");
});
