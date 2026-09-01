import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateJob } from "../src/server/generation.js";
import { defaultSettings } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";

test("invalid canonical JSON profiles fail closed and the removed renderer is absent", async () => {
  const source = await readFile(join(process.cwd(), "src/server/generation.ts"), "utf8");
  assert.doesNotMatch(source, /renderLegacyProfile/);
  const dir = await mkdtemp(join(tmpdir(), "pjs-cleanup-"));
  const db = openDatabase(":memory:");
  const id = randomUUID();
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "cleanup-source", "manual", "https://example.test/cleanup", "Example", "Engineer", "Posting", 80, JSON.stringify({ reason: "fit", strengths: [], gaps: [] }), "Selected", "2026-08-31T00:00:00.000Z", "2026-08-31T00:00:00.000Z");
  try {
    await assert.rejects(() => generateJob({ db, dataDir: dir, jobId: id, settings: defaultSettings, profile: '{"version":1}', execute: async () => ({}), signal: new AbortController().signal }), /canonical structured profile is invalid/i);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
