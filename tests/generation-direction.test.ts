import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.js";
import { buildServer } from "../src/server/app.js";
import { defaultGenerationDirection } from "../src/shared.js";

function insertJob(db: any, stage = "Selected", suffix = "1") {
  const id = randomUUID();
  db.prepare("INSERT INTO jobs(id,source_id,source,url,company,role,posting,score,rank_json,stage,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `s-${suffix}`, "freehire", `https://example.test/${suffix}`, "Example", "Engineer", "Posting", 80, JSON.stringify({ reason: "fit", strengths: [], gaps: ["Kubernetes"] }), stage, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  return id;
}

async function withApp(run: (app: Awaited<ReturnType<typeof buildServer>>, db: ReturnType<typeof openDatabase>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pjs-direction-"));
  const db = openDatabase(":memory:");
  const app = await buildServer({ dataDir: dir, db });
  try { await run(app, db); }
  finally { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
}

test("GET after Select includes default generation_direction without an applications row", async () => {
  await withApp(async (app, db) => {
    const id = insertJob(db, "Selected", "default");
    const count = db.prepare("SELECT count(*) AS count FROM applications").get() as { count: number };
    assert.equal(count.count, 0);
    const response = await app.inject({ method: "GET", url: `/api/jobs/${id}` });
    assert.equal(response.statusCode, 200);
    const job = response.json();
    assert.deepEqual(job.generation_direction, defaultGenerationDirection);
    assert.equal(job.generation_direction.cvLength, "complete");
    assert.equal(job.generation_direction.letterMode, "standard");
    assert.equal(job.generation_direction.revisionCount, 0);
    assert.equal("generation_direction_json" in job, false);
  });
});

test("PUT cvLength short round-trips and keeps other fields and Selected stage", async () => {
  await withApp(async (app, db) => {
    const id = insertJob(db, "Selected", "short");
    const put = await app.inject({ method: "PUT", url: `/api/jobs/${id}/direction`, payload: { cvLength: "short" } });
    assert.equal(put.statusCode, 200);
    const get = await app.inject({ method: "GET", url: `/api/jobs/${id}` });
    assert.equal(get.statusCode, 200);
    const job = get.json();
    assert.equal(job.stage, "Selected");
    assert.deepEqual(job.generation_direction, { ...defaultGenerationDirection, cvLength: "short" });
    assert.equal("generation_direction_json" in job, false);
  });
});

test("PUT on Applied or Recommended returns 409", async () => {
  await withApp(async (app, db) => {
    const applied = insertJob(db, "Applied", "applied");
    const recommended = insertJob(db, "Recommended", "recommended");
    const appliedPut = await app.inject({ method: "PUT", url: `/api/jobs/${applied}/direction`, payload: { cvLength: "short" } });
    assert.equal(appliedPut.statusCode, 409);
    const recommendedPut = await app.inject({ method: "PUT", url: `/api/jobs/${recommended}/direction`, payload: { cvLength: "short" } });
    assert.equal(recommendedPut.statusCode, 409);
  });
});

test("PUT revisionCount 4 returns 400", async () => {
  await withApp(async (app, db) => {
    const id = insertJob(db, "Selected", "cap");
    const response = await app.inject({ method: "PUT", url: `/api/jobs/${id}/direction`, payload: { revisionCount: 4 } });
    assert.equal(response.statusCode, 400);
  });
});

test("PUT unknown key returns 400", async () => {
  await withApp(async (app, db) => {
    const id = insertJob(db, "Selected", "unknown");
    const response = await app.inject({ method: "PUT", url: `/api/jobs/${id}/direction`, payload: { cvLength: "short", extra: true } });
    assert.equal(response.statusCode, 400);
  });
});

test("PUT on Ready does not change stage", async () => {
  await withApp(async (app, db) => {
    const id = insertJob(db, "Ready", "ready");
    const put = await app.inject({ method: "PUT", url: `/api/jobs/${id}/direction`, payload: { cvLength: "short" } });
    assert.equal(put.statusCode, 200);
    const job = (await app.inject({ method: "GET", url: `/api/jobs/${id}` })).json();
    assert.equal(job.stage, "Ready");
    assert.equal(job.generation_direction.cvLength, "short");
    assert.equal(job.approved_at ?? null, null);
  });
});
