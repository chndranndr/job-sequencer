import test from "node:test"; import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {cleanupStaleRuns,openDatabase,persistScrape,listJobs,toggleSelection} from "../src/server/db.js";
const job=(id:string,url=`https://EXAMPLE.test/jobs/${id}/?utm_source=x`,score=81)=>({sourceId:id,source:"freehire",url,company:"Example",role:"Engineer",location:"Remote",posting:"Build",score,reason:"fit",strengths:[],gaps:[]});
test("four-table schema and stale running cleanup",()=>{const db=openDatabase(":memory:");try{const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(x=>x.name);for(const name of ["jobs","applications","runs","migrations"])assert.ok(tables.includes(name));db.prepare("INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES('r','scrape','running','p','m','x')").run();assert.equal(cleanupStaleRuns(db),1);assert.equal((db.prepare("SELECT status FROM runs WHERE id='r'").get() as any).status,"failed");}finally{db.close()}});
test("URL upsert preserves selection and a failed batch rolls back",()=>{const db=openDatabase(":memory:");try{persistScrape(db,{jobs:[job("1")]});let row=(listJobs(db) as any[])[0];toggleSelection(db,row.id);persistScrape(db,{jobs:[job("1","https://example.test/jobs/1",10)]});row=db.prepare("SELECT * FROM jobs").get() as any;assert.equal(row.stage,"Selected");assert.equal(row.score,10);assert.throws(()=>persistScrape(db,{jobs:[job("2"),job("3","bad-url")]}));assert.equal((db.prepare("SELECT count(*) n FROM jobs").get() as any).n,1);}finally{db.close()}});

test("Phase 1 run columns are nullable and migration is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pjs-phase1-db-"));
  const path = join(directory, "jobs.sqlite");
  const columns = ["error_code", "attempt_count", "input_tokens", "output_tokens", "total_tokens", "estimated_cost", "prompt_hash", "guidance_hash", "settings_hash"];
  try {
    const first = openDatabase(path);
    try {
      first.prepare("INSERT INTO runs(id,workflow,status,provider,model,started_at) VALUES('phase1','test','succeeded','fixture','model','2026-08-20T00:00:00.000Z')").run();
      const firstColumns = (first.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(value => value.name);
      for (const column of columns) assert.ok(firstColumns.includes(column), column);
      const firstRow = first.prepare("SELECT * FROM runs WHERE id='phase1'").get() as Record<string, unknown>;
      for (const column of columns) assert.equal(firstRow[column], null, column);
    } finally {
      first.close();
    }

    const second = openDatabase(path);
    try {
      const secondColumns = (second.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(value => value.name);
      for (const column of columns) assert.ok(secondColumns.includes(column), column);
      const secondRow = second.prepare("SELECT * FROM runs WHERE id='phase1'").get() as Record<string, unknown>;
      for (const column of columns) assert.equal(secondRow[column], null, column);
    } finally {
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
