import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.js";

test("opening an old database migrates runs.workflow without losing trajectory rows or foreign keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-manual-migration-"));
  const path = join(dir, "jobs.sqlite3");
  const old = new DatabaseSync(path);
  old.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL CHECK(workflow IN ('scrape','generate','interview','follow_up','test')), job_id TEXT, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled','timed_out')), provider TEXT NOT NULL, model TEXT NOT NULL, summary_json TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE run_trajectory_events (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, kind TEXT NOT NULL, event_type TEXT NOT NULL, timestamp TEXT NOT NULL, started_at TEXT, ended_at TEXT, duration_ms REAL, payload_json TEXT, PRIMARY KEY(run_id, sequence));
    CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES('old-run','test','succeeded','fixture','model','2026-08-20T00:00:00.000Z');
    INSERT INTO run_trajectory_events(run_id,sequence,kind,event_type,timestamp,payload_json) VALUES('old-run',1,'lifecycle','run_completed','2026-08-20T00:00:01.000Z','{}');
  `);
  old.close();

  const db = openDatabase(path);
  try {
    db.prepare("INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES(?,?,?,?,?,?)").run("manual-run", "manual_import", "running", "fixture", "model", "2026-08-20T00:00:00.000Z");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_trajectory_events WHERE run_id='old-run'").get() as { count: number }).count, 1);
    const foreignKey = db.prepare("PRAGMA foreign_key_list(run_trajectory_events)").all() as Array<{ table: string; on_delete: string }>;
    assert.equal(foreignKey[0]?.table, "runs");
    assert.equal(foreignKey[0]?.on_delete, "CASCADE");
    db.prepare("DELETE FROM runs WHERE id='old-run'").run();
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM run_trajectory_events WHERE run_id='old-run'").get() as { count: number }).count, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
