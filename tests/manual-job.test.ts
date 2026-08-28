import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server/app.js";
import { openDatabase, persistManualJob } from "../src/server/db.js";
import { writeSettings, writeStructuredProfile } from "../src/server/config.js";
import { createEmptyProfile } from "../src/shared.js";
import { MAX_MANUAL_FETCH_BYTES, importManualJob, ManualJobRunManager, parseManualJobText, validateManualUrl, type ManualJobImportResult } from "../src/server/manual-job.js";
import type { PiSessionLike } from "../src/server/pi.js";

const settings = {
  provider: "job-sequencer-faux",
  model: "phase0",
  source: "freehire" as const,
  enabledSources: ["freehire"],
  customSources: [],
  sourceMaxAgeDays: { freehire: 9999, linkedin: 9999, tokyodev: 45, "japan-dev": 45 },
  scoreThreshold: 60,
  maxResults: 50,
  cvPages: 2,
  coverLetterPages: 1,
};

const profileContext = JSON.stringify({
  identity: { headline: "Backend Engineer", summary: "TypeScript backend engineer." },
  workPreferences: { remotePreference: "Remote", targetRoles: ["Backend Engineer"] },
  skills: [{ name: "TypeScript" }],
});
const criteriaContext = { roles: ["Backend Engineer"], locations: ["Remote"], remoteOnly: true, keywords: ["TypeScript"], excludeKeywords: [], employmentTypes: ["full-time"], maxJobsPerRun: 20 };

class FakeSession implements PiSessionLike {
  private listener: ((event: unknown) => void) | null = null;
  constructor(private readonly response: string, private readonly onPrompt?: (prompt: string) => void) {}
  subscribe(listener: (event: unknown) => void) { this.listener = listener; return () => { this.listener = null; }; }
  async prompt(prompt: string) { this.onPrompt?.(prompt); this.listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: this.response } }); }
  async abort() {}
  dispose() {}
}

function parsedJob(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ company: "Example Co", role: "Backend Engineer", location: "Remote", posting: "Build reliable APIs.\n\nOwn the service lifecycle.", sourceUrl: "", score: 84, reason: "Strong match for the backend profile.", strengths: ["TypeScript"], gaps: ["No production scale detail supplied."], ...overrides });
}

const fixtureImport: ManualJobImportResult = {
  inputType: "text",
  url: "manual://fixture-job",
  job: { company: "Fixture Co", role: "Platform Engineer", location: "Jakarta", posting: "Operate platforms.\n\nImprove reliability.", sourceUrl: "", score: 82, reason: "Platform experience matches the profile.", strengths: ["Reliability"], gaps: ["Cloud provider is not specified."] },
};

async function waitForRun(app: Awaited<ReturnType<typeof buildServer>>, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = (await app.inject({ url: `/api/runs/${id}` })).json() as { status: string; error?: string };
    if (run.status !== "running" && run.status !== "queued") return run;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("manual run did not finish");
}

test("manual Pi parsing is strict, profile-grounded, scored, and preserves the full posting", async () => {
  const promptParts: string[] = [];
  const result = await parseManualJobText("Example Co\nBackend Engineer\nBuild reliable APIs.", settings, {
    profile: profileContext,
    criteria: criteriaContext,
    sourceUrls: ["https://jobs.example.test/backend"],
    createSession: async () => new FakeSession(parsedJob({ sourceUrl: "https://jobs.example.test/backend" }), (prompt) => promptParts.push(prompt)),
  });
  assert.equal(result.posting, "Build reliable APIs.\n\nOwn the service lifecycle.");
  assert.equal(result.sourceUrl, "https://jobs.example.test/backend");
  assert.equal(result.score, 84);
  assert.deepEqual(result.strengths, ["TypeScript"]);
  assert.deepEqual(result.gaps, ["No production scale detail supplied."]);
  assert.match(promptParts[0] ?? "", /untrusted data/i);
  assert.match(promptParts[0] ?? "", /TypeScript backend engineer/);
  assert.match(promptParts[0] ?? "", /Backend Engineer/);
  assert.match(promptParts[0] ?? "", /score.*0.*100/i);
  await assert.rejects(parseManualJobText("bad", settings, {
    profile: profileContext,
    createSession: async () => new FakeSession(parsedJob({ extra: "not allowed" })),
  }), /could not be validated/i);
});

test("manual import does not fetch pasted text and uses a synthetic URL", async () => {
  let fetchCalls = 0;
  const result = await importManualJob("https://jobs.example.test/backend\nExample Co\nBackend Engineer\nBuild APIs.", settings, {
    profile: profileContext,
    fetch: async () => { fetchCalls++; throw new Error("network must not be used for pasted text"); },
    createSession: async () => new FakeSession(parsedJob()),
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.inputType, "text");
  assert.match(result.url, /^manual:\/\//);
});

test("manual URL import validates destinations, redirects manually, and bounds response bytes", async () => {
  assert.throws(() => validateManualUrl("http://127.0.0.1/job"), /private|local/i);
  assert.throws(() => validateManualUrl("https://user:pass@example.test/job"), /credentials/i);
  assert.throws(() => validateManualUrl("ftp://example.test/job"), /HTTP/i);

  let prompt = "";
  const result = await importManualJob("https://jobs.example.test/backend/", settings, {
    profile: profileContext,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (_input, init) => {
      assert.equal(init?.redirect, "manual");
      return new Response("<html><h1>Backend Engineer</h1><p>Build reliable APIs.</p></html>");
    },
    createSession: async () => new FakeSession(parsedJob(), (value) => { prompt = value; }),
  });
  assert.equal(result.inputType, "url");
  assert.equal(result.url, "https://jobs.example.test/backend");
  assert.match(prompt, /Build reliable APIs/);

  await assert.rejects(importManualJob("https://jobs.example.test/large", settings, {
    profile: profileContext,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => new Response("x".repeat(MAX_MANUAL_FETCH_BYTES + 1)),
    createSession: async () => new FakeSession(parsedJob()),
  }), /too large/i);
});

test("manual Workday URL import uses bounded structured metadata when the body is a JS shell", async () => {
  const url = "https://japfa.wd102.myworkdayjobs.com/en-US/External/job/Head-Office-STP_Head-Office-Jakarta/SOFTWARE-DEVELOPER-SENIOR-STAFF-HO_JR484?source=LinkedIn";
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="SOFTWARE DEVELOPER SENIOR STAFF - HO">
    <meta property="og:description" content="Develop and support enterprise software &amp; services in Jakarta.">
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "SOFTWARE DEVELOPER SENIOR STAFF - HO",
      description: "Develop and support enterprise software &amp; services in Jakarta. Job identifier: JR484.",
      hiringOrganization: { "@type": "Organization", name: "PT Japfa Comfeed Indonesia Tbk" },
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Jakarta", addressCountry: "ID" } },
      identifier: { "@type": "PropertyValue", name: "Workday", value: "JR484" },
    })}</script>
  </head><body><div id="root"></div><script>window.__INITIAL_STATE__ = {};</script></body></html>`;
  let prompt = "";
  const result = await importManualJob(url, settings, {
    profile: profileContext,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (_input, init) => {
      assert.equal(init?.redirect, "manual");
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
    createSession: async () => new FakeSession(parsedJob({
      company: "PT Japfa Comfeed Indonesia Tbk",
      role: "SOFTWARE DEVELOPER SENIOR STAFF - HO",
      location: "Jakarta",
      posting: "Develop and support enterprise software & services in Jakarta. Job identifier: JR484.",
      sourceUrl: url,
    }), (value) => { prompt = value; }),
  });

  assert.equal(result.inputType, "url");
  assert.equal(result.url, url);
  assert.match(prompt, /SOFTWARE DEVELOPER SENIOR STAFF - HO/);
  assert.match(prompt, /PT Japfa Comfeed Indonesia Tbk/);
  assert.match(prompt, /Jakarta/);
  assert.match(prompt, /JR484/);
  assert.match(prompt, /enterprise software & services/);
});

test("manual URL import strips oversized HTML noise before sending visible job text to Pi", async () => {
  const hiddenScript = "hidden-script-marker ".repeat(7_000);
  const hiddenStyle = "hidden-style-marker ".repeat(2_000);
  const html = `<!--hidden-comment-marker--><html><head><style>${hiddenStyle}</style></head><body><noscript>hidden-noscript-marker</noscript><template>hidden-template-marker</template><svg>hidden-svg-marker</svg><script>${hiddenScript}</script><main><h1>Senior Java Developer</h1><p>Avenga &amp; Co&#x2D;Europe</p><p>Build and operate WildFly enterprise applications.</p><ul><li>Work with Java and Spring.</li></ul></main></body></html>`;
  assert.ok(html.length > 120_000);

  let prompt = "";
  const result = await importManualJob("https://jobs.example.test/large-html", settings, {
    profile: profileContext,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async () => new Response(html),
    createSession: async () => new FakeSession(parsedJob({ company: "Avenga", role: "Senior Java Developer" }), (value) => { prompt = value; }),
  });

  assert.equal(result.inputType, "url");
  assert.match(prompt, /Senior Java Developer/);
  assert.match(prompt, /Senior Java Developer\n\nAvenga & Co-Europe/);
  assert.match(prompt, /Build and operate WildFly enterprise applications/);
  assert.match(prompt, /Work with Java and Spring/);
  assert.doesNotMatch(prompt, /hidden-comment-marker|hidden-noscript-marker|hidden-template-marker|hidden-svg-marker/);
  assert.doesNotMatch(prompt, /hidden-script-marker/);
  assert.doesNotMatch(prompt, /hidden-style-marker/);
});

test("manual LinkedIn collection and view URLs use canonical guest details before Pi scoring", async () => {
  const canonicalUrl = "https://www.linkedin.com/jobs/view/4457070333";
  const description = "Build the product surface and backend services.\n\nWork with TypeScript and React.";
  const ids: string[] = [];
  const prompts: string[] = [];
  const fetchLinkedInDetail = async (id: string) => {
    ids.push(id);
    return { title: "Full-Stack Developer (Remote)", company: "Example Co", location: "Remote", description };
  };
  const options = {
    profile: profileContext,
    criteria: criteriaContext,
    fetch: async () => { throw new Error("generic HTML fetch must not be used for LinkedIn"); },
    fetchLinkedInDetail,
    createSession: async () => new FakeSession(parsedJob({ company: "Example Co", role: "Full-Stack Developer (Remote)", posting: description, sourceUrl: canonicalUrl, score: 91 }), (prompt) => prompts.push(prompt)),
  };

  const collection = await importManualJob("https://www.linkedin.com/jobs/collections/recommended?currentJobId=4457070333", settings, options);
  const direct = await importManualJob(canonicalUrl, settings, options);

  assert.deepEqual(ids, ["4457070333", "4457070333"]);
  assert.equal(collection.url, canonicalUrl);
  assert.equal(direct.url, canonicalUrl);
  assert.equal(collection.job.score, 91);
  assert.equal(collection.job.sourceUrl, canonicalUrl);
  assert.match(prompts[0] ?? "", /Full-Stack Developer \(Remote\)/);
  assert.match(prompts[0] ?? "", /Example Co/);
  assert.match(prompts[0] ?? "", /Remote/);
  assert.match(prompts[0] ?? "", /Work with TypeScript and React/);
  assert.match(prompts[0] ?? "", /https:\/\/www\.linkedin\.com\/jobs\/view\/4457070333/);
});

test("manual LinkedIn duplicate checks use the canonical view URL", async () => {
  const db = openDatabase(":memory:");
  try {
    persistManualJob(db, { ...fixtureImport, inputType: "url", url: "https://www.linkedin.com/jobs/view/4457070333" }, 60);
    const manager = new ManualJobRunManager({
      db,
      load: async () => ({ profile: profileContext, criteria: criteriaContext, settings }),
    });
    await assert.rejects(manager.start("https://www.linkedin.com/jobs/collections/recommended?currentJobId=4457070333"), /already exists/i);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count, 1);
  } finally { db.close(); }
});

test("manual run rejects blank input before creating state or invoking importer", async () => {
  const db = openDatabase(":memory:");
  let importerCalls = 0;
  const manager = new ManualJobRunManager({
    db,
    load: async () => ({ profile: profileContext, criteria: criteriaContext, settings }),
    importer: async () => {
      importerCalls++;
      await new Promise<void>(() => {});
      return fixtureImport;
    },
  });
  try {
    await assert.rejects(manager.start("   "), { message: "Enter a posting URL or paste job text." });
    assert.equal(importerCalls, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 0);
  } finally { db.close(); }
});

test("manual LinkedIn import returns an actionable error when detail is unavailable", async () => {
  const input = "https://www.linkedin.com/jobs/collections/recommended?currentJobId=4457070333";
  const safeError = /LinkedIn job details could not be fetched; paste the job description text or use a direct LinkedIn job URL\./i;
  await assert.rejects(importManualJob(input, settings, {
    profile: profileContext,
    fetchLinkedInDetail: async () => ({ title: "Full-Stack Developer (Remote)", company: "Example Co", location: "Remote", description: "" }),
    createSession: async () => { throw new Error("Pi must not receive an empty detail"); },
  }), safeError);
  await assert.rejects(importManualJob(input, settings, {
    profile: profileContext,
    fetchLinkedInDetail: async () => { throw new Error("guest fetch failed"); },
    createSession: async () => { throw new Error("Pi must not receive a failed detail"); },
  }), safeError);
  await assert.rejects(importManualJob("https://www.linkedin.com/jobs/collections/recommended?currentJobId=not-a-number", settings, {
    profile: profileContext,
    createSession: async () => { throw new Error("Pi must not receive an invalid LinkedIn URL"); },
  }), safeError);
});

test("manual persistence uses score threshold, rank fields, Manual source, and rejects duplicate real URLs", () => {
  const db = openDatabase(":memory:");
  try {
    const result = persistManualJob(db, { ...fixtureImport, inputType: "url", url: "https://jobs.example.test/fixture" }, 60);
    assert.equal(result.source, "manual");
    assert.equal(result.stage, "Recommended");
    assert.equal(result.score, 82);
    assert.equal(result.rank.reason, "Platform experience matches the profile.");
    assert.deepEqual(result.rank.strengths, ["Reliability"]);
    assert.deepEqual(result.rank.gaps, ["Cloud provider is not specified."]);
    assert.equal(result.posting, fixtureImport.job.posting);
    assert.equal(result.url, "https://jobs.example.test/fixture");
    const discarded = persistManualJob(db, { ...fixtureImport, inputType: "url", url: "https://jobs.example.test/discarded", job: { ...fixtureImport.job, score: 60 } }, 60);
    assert.equal(discarded.stage, "Discarded");
    assert.throws(() => persistManualJob(db, { ...fixtureImport, inputType: "url", url: "https://jobs.example.test/fixture" }, 60), /already exists/i);
  } finally { db.close(); }
});

test("manual API starts an async scored run and persists Pi trajectory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-manual-api-"));
  const db = openDatabase(":memory:");
  await writeSettings(dir, settings);
  const profile = createEmptyProfile();
  profile.identity.headline = "Backend Engineer";
  profile.identity.summary = "TypeScript backend engineer.";
  await writeStructuredProfile(dir, profile);
  let importerOptions: { profile?: string; runId?: string; trajectory?: unknown } | undefined;
  const app = await buildServer({ dataDir: dir, db, manualImporter: async (input, configured, options) => {
    importerOptions = options;
    return importManualJob(input, configured, { ...options, profile: options?.profile ?? "", createSession: async () => new FakeSession(parsedJob()) });
  } });
  try {
    const response = await app.inject({ method: "POST", url: "/api/jobs/manual", payload: { input: "pasted job" } });
    assert.equal(response.statusCode, 202);
    const runId = response.json().runId as string;
    const run = await waitForRun(app, runId);
    assert.equal(run.status, "succeeded");
    assert.equal(importerOptions?.runId, runId);
    assert.equal(typeof importerOptions?.trajectory, "function");
    const jobs = (await app.inject({ url: "/api/jobs" })).json().jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].score, 84);
    assert.equal(jobs[0].rank.reason, "Strong match for the backend profile.");
    assert.equal(jobs[0].stage, "Recommended");
    const events = (await app.inject({ url: `/api/runs/${runId}/trajectory` })).json().events;
    assert.ok(events.some((event: { type: string }) => event.type === "user_prompt"));
    assert.ok(events.some((event: { type: string; payload?: { taskId?: string } }) => event.type === "task_completed" && event.payload?.taskId === "manual_import:parse-score"));
    assert.ok(events.some((event: { type: string; payload?: { taskId?: string } }) => event.type === "task_completed" && event.payload?.taskId === "manual_import:persist"));
    assert.equal((await app.inject({ method: "POST", url: "/api/jobs/manual", payload: { input: "" } })).statusCode, 400);
  } finally { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("manual run queues overlap and leaves no job on importer failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-manual-failure-"));
  const db = openDatabase(":memory:");
  await writeSettings(dir, settings);
  await writeStructuredProfile(dir, createEmptyProfile());
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const app = await buildServer({ dataDir: dir, db, manualImporter: async (input) => {
    if (input === "blocked") { await blocked; return fixtureImport; }
    if (input === "duplicate") return fixtureImport;
    throw new Error("fixture parser failed");
  } });
  try {
    const first = await app.inject({ method: "POST", url: "/api/jobs/manual", payload: { input: "blocked" } });
    assert.equal(first.statusCode, 202);
    const overlap = await app.inject({ method: "POST", url: "/api/jobs/manual", payload: { input: "second" } });
    assert.equal(overlap.statusCode, 202);
    release();
    assert.equal((await waitForRun(app, first.json().runId)).status, "succeeded");
    const overlapRun = await waitForRun(app, overlap.json().runId);
    assert.equal(overlapRun.status, "failed");
    const duplicate = await app.inject({ method: "POST", url: "/api/jobs/manual", payload: { input: "duplicate" } });
    assert.equal(duplicate.statusCode, 202);
    const duplicateRun = await waitForRun(app, duplicate.json().runId);
    assert.equal(duplicateRun.status, "failed");
    assert.match(duplicateRun.error ?? "", /already exists/i);
    const failed = await app.inject({ method: "POST", url: "/api/jobs/manual", payload: { input: "failed" } });
    assert.equal(failed.statusCode, 202);
    const failedRun = await waitForRun(app, failed.json().runId);
    assert.equal(failedRun.status, "failed");
    assert.match(failedRun.error ?? "", /manual job import failed/i);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count, 1);
    const failedEvents = (await app.inject({ url: `/api/runs/${failed.json().runId}/trajectory` })).json().events;
    assert.ok(failedEvents.some((event: { type: string }) => event.type === "task_failed"));
  } finally { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("manual API checks the reviewed structured profile before creating a run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-manual-prereq-"));
  const db = openDatabase(":memory:");
  await writeSettings(dir, settings);
  const app = await buildServer({ dataDir: dir, db, manualImporter: async () => fixtureImport });
  try {
    const response = await app.inject({ method: "POST", url: "/api/jobs/manual", payload: { input: "job text" } });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /structured profile/i);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count, 0);
  } finally { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});
