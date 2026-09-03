import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/server/db.js";
import { buildServer } from "../src/server/app.js";
import { PiRunTimeoutError } from "../src/server/pi.js";
import { createEmptyProfile } from "../src/shared.js";

const fixture = { sourceId:"free-1", source:"freehire", url:"https://example.test/1", company:"Example", role:"Backend", location:"Remote", posting:"APIs", score:81, reason:"Strong", strengths:["TS"], gaps:[] };
async function wait(app:any,id:string){ for(let i=0;i<30;i++){ const response=await app.inject({url:`/api/runs/${id}`}); const body=response.json(); if(body.status!=="running")return body; await new Promise(resolve=>setTimeout(resolve,5)); } throw new Error("run did not finish"); }

test("API saves configuration, runs scrape, filters discarded, and selection stays manual", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pjs-api-")); const db=openDatabase(":memory:");
  const second={...fixture,sourceId:"free-2",url:"https://example.test/2",score:60};
  const app=await buildServer({dataDir:dir,db,scrapeExecutor:async()=>({result:{jobs:[fixture,second]},provenance:new Map([[fixture.sourceId,fixture.url],[second.sourceId,second.url]])})});
  try {
    assert.equal((await app.inject({method:"PUT",url:"/api/profile",payload:{profile:"# Me"}})).statusCode,200);
    const start=await app.inject({method:"POST",url:"/api/scrape"}); assert.equal(start.statusCode,202);
    const done=await wait(app,start.json().runId); assert.equal(done.status,"succeeded"); assert.deepEqual(done.summary,{jobsFound:2,recommended:1,discarded:1,duplicatesSkipped:0,errors:[],warnings:[]});
    let jobs=(await app.inject({url:"/api/jobs"})).json().jobs; assert.equal(jobs.length,1); assert.equal(jobs[0].stage,"Recommended");
    await app.inject({method:"POST",url:`/api/jobs/${jobs[0].id}/select`}); jobs=(await app.inject({url:"/api/jobs?stage=Discarded"})).json().jobs; assert.equal(jobs.length,1); assert.equal(jobs[0].score,60);
    const bad=await app.inject({method:"PUT",url:"/api/criteria",payload:{bad:true}}); assert.equal(bad.statusCode,400); assert.deepEqual(Object.keys(bad.json()),["error"]);
  } finally { await app.close(); db.close(); await rm(dir,{recursive:true,force:true}); }
});

test("available model endpoint returns provider-authenticated Pi model options", async()=>{
  const db=openDatabase(":memory:"); let requestedProvider="";
  const app=await buildServer({db,availableModels:async provider=>{requestedProvider=provider;return[{id:"gpt-5.6-luna",name:"GPT-5.6 Luna"}];}});
  try { const response=await app.inject({url:"/api/ai/models?provider=openai-codex"}); assert.equal(response.statusCode,200); assert.deepEqual(response.json(),{provider:"openai-codex",models:[{id:"gpt-5.6-luna",name:"GPT-5.6 Luna"}]}); assert.equal(requestedProvider,"openai-codex"); }
  finally { await app.close(); db.close(); }
});

test("profile API exposes the deterministic CV page estimate", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pjs-profile-estimate-")); const db=openDatabase(":memory:"); const app=await buildServer({dataDir:dir,db});
  try {
    const saved=await app.inject({method:"PUT",url:"/api/profile",payload:{profile:createEmptyProfile()}});
    assert.equal(saved.statusCode,200); assert.equal(saved.json().cvPageEstimate,1);
    const response=await app.inject({url:"/api/profile"}); assert.equal(response.statusCode,200); assert.equal(response.json().cvPageEstimate,1);
  } finally { await app.close(); db.close(); await rm(dir,{recursive:true,force:true}); }
});

test("profile import enqueues a run and returns the draft in the run summary", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pjs-import-")); const db=openDatabase(":memory:");
  const parsed=createEmptyProfile(); parsed.identity.firstName="Candidate";
  let receivedName=""; let receivedType=""; let receivedText=""; let receivedCurrent="";
  const app=await buildServer({
    dataDir:dir,
    db,
    profileImporter:async (file, _settings, options)=>{
      receivedName=file.filename;
      receivedType=file.mimetype;
      receivedText=file.buffer.toString("utf8");
      receivedCurrent=options?.currentProfile?.identity.firstName ?? "";
      return {
        profile:parsed,
        extracted:parsed,
        source:{fileName:file.filename,format:"pdf",textLength:receivedText.length},
        identity:{conflict:false,currentName:"",incomingName:"Candidate",reason:""},
      };
    },
  });
  const boundary="----pjs-test-boundary";
  const currentProfile=JSON.stringify({...createEmptyProfile(),identity:{...createEmptyProfile().identity,firstName:"Draft"}});
  const payload=Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resume.pdf"\r\nContent-Type: application/pdf\r\n\r\nResume text from upload\r\n`+
    `--${boundary}\r\nContent-Disposition: form-data; name="currentProfile"\r\n\r\n${currentProfile}\r\n`+
    `--${boundary}--\r\n`
  );
  try {
    assert.equal((await app.inject({method:"PUT",url:"/api/settings",payload:{provider:"fixture",model:"test",source:"freehire",enabledSources:["freehire"],scoreThreshold:60,maxResults:50,cvPages:2,coverLetterPages:1}})).statusCode,200);
    const response=await app.inject({method:"POST",url:"/api/profile/import",headers:{"content-type":`multipart/form-data; boundary=${boundary}`},payload});
    assert.equal(response.statusCode,202);
    assert.equal(typeof response.json().runId,"string");
    const done=await wait(app,response.json().runId);
    assert.equal(done.status,"succeeded");
    assert.equal(done.workflow,"profile_import");
    assert.deepEqual(done.summary.profile,parsed);
    assert.equal(done.summary.identity.conflict,false);
    assert.equal(receivedName,"resume.pdf");
    assert.equal(receivedType,"application/pdf");
    assert.equal(receivedText,"Resume text from upload");
    assert.equal(receivedCurrent,"Draft");
  } finally { await app.close(); db.close(); await rm(dir,{recursive:true,force:true}); }
});

test("cancelled runs persist no jobs and expose safe errors",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pjs-run-")); const db=openDatabase(":memory:");
  const app=await buildServer({dataDir:dir,db,scrapeExecutor:async({signal})=>await new Promise((resolve,reject)=>{ signal.addEventListener("abort",()=>reject(Object.assign(new Error("private provider detail"),{name:"AbortError"})),{once:true}); })});
  try { const start=(await app.inject({method:"POST",url:"/api/scrape"})).json(); await app.inject({method:"POST",url:`/api/runs/${start.runId}/cancel`}); const done=await wait(app,start.runId); assert.equal(done.status,"cancelled"); assert.equal(done.error,"Scrape cancelled."); assert.equal((db.prepare("SELECT count(*) n FROM jobs").get() as any).n,0); }
  finally { await app.close(); db.close(); await rm(dir,{recursive:true,force:true}); }
});

test("failed and timed-out runs are safe and persist nothing",async()=>{
  for(const [error,status,message] of [[new Error("credential value"),"failed","Scrape failed. Check provider settings and try again."],[new PiRunTimeoutError(),"timed_out","Scrape timed out."]] as const){
    const dir=await mkdtemp(join(tmpdir(),"pjs-fail-")); const db=openDatabase(":memory:"); const app=await buildServer({dataDir:dir,db,scrapeExecutor:async()=>{throw error;}});
    try{const started=(await app.inject({method:"POST",url:"/api/scrape"})).json();const done=await wait(app,started.runId);assert.equal(done.status,status);assert.equal(done.error,message);assert.equal(done.error_code,status==="failed"?"provider":status==="timed_out"?"timeout":null);assert.equal((db.prepare("SELECT count(*) n FROM jobs").get() as any).n,0);}finally{await app.close();db.close();await rm(dir,{recursive:true,force:true});}
  }
});
