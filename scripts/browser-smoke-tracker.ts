import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { buildServer } from "../src/server/app.js";
import { writeSettings, writeStructuredProfile } from "../src/server/config.js";
import { listJobs, openDatabase, persistScrape, setJobStage } from "../src/server/db.js";
import { createEmptyProfile } from "../src/shared.js";
import type { ApplicationStrategy, CVDocument } from "../src/server/agents/types.js";
import type { RunStrategistInput } from "../src/server/agents/strategist.js";
import type { RunWriterInput } from "../src/server/agents/writer.js";
import type { ManualJobImportResult } from "../src/server/manual-job.js";
import type { CommandRunner } from "../src/server/documents.js";

const fixtures = [
  {
    sourceId: "tracker-browser-job",
    source: "freehire",
    url: "https://example.test/tracker-browser-job",
    company: "Tracker Example",
    role: "Platform Engineer",
    location: "Remote",
    posting: "Operate the platform.\n\nImprove reliability.",
    score: 88,
    reason: "Platform reliability matches the reviewed profile.",
    strengths: ["Reliability"],
    gaps: ["Cloud scope is not stated."],
  },
  {
    sourceId: "tracker-browser-job-two",
    source: "freehire",
    url: "https://example.test/tracker-browser-job-two",
    company: "Tracker Backend",
    role: "Backend Engineer",
    location: "Remote",
    posting: "Build reliable services.",
    score: 72,
    reason: "Backend experience matches the reviewed profile.",
    strengths: ["Backend"],
    gaps: ["Scale is not stated."],
  },
];

const manualPostingFixture = "Tracker Manual\nSite Reliability Engineer\nRemote\n\nOwn resilient systems and improve service reliability.";
const manualImportFixture: ManualJobImportResult = {
  inputType: "text",
  url: "manual://tracker-browser-manual",
  job: {
    company: "Tracker Manual",
    role: "Site Reliability Engineer",
    location: "Remote",
    posting: "Own resilient systems and improve service reliability.",
    sourceUrl: "",
    score: 91,
    reason: "Reliability work matches the smoke profile.",
    strengths: ["Reliability"],
    gaps: ["Cloud scope is not stated."],
  },
};

const smokeSettings = {
  provider: "job-sequencer-faux",
  model: "fixture",
  source: "freehire" as const,
  enabledSources: ["freehire"],
  customSources: [],
  sourceMaxAgeDays: { freehire: 9999, linkedin: 9999, tokyodev: 45, "japan-dev": 45 },
  scoreThreshold: 60,
  maxResults: 50,
  cvPages: 2,
  coverLetterPages: 1,
};

async function freePort() {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => resolve()); });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve Tracker browser smoke port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForFrontend(port: number) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch { /* Vite is still starting. */ }
    await delay(50);
  }
  throw new Error("Tracker smoke frontend did not start.");
}

async function openTracker(page: import("playwright").Page, base: string, hash = "") {
  await page.goto(`${base}/${hash}`);
  await page.locator(".studio").waitFor();
}

async function assertNoOverflow(page: import("playwright").Page, label: string) {
  const geometry = await page.evaluate(() => ({
    documentWidth: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  if (geometry.pageWidth > geometry.documentWidth + 1 || geometry.bodyWidth > geometry.documentWidth + 1) {
    throw new Error(`Tracker horizontal overflow at ${label}: ${JSON.stringify(geometry)}`);
  }
}

const fakeRunner: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
const generationRunner: CommandRunner = async (executable, args, _timeout, cwd) => {
  if (executable === "lualatex") await writeFile(join(cwd!, "cv.pdf"), "pdf");
  if (executable === "xelatex") await writeFile(join(cwd!, "cover-letter.pdf"), "pdf");
  if (executable === "pdfinfo") return { code: 0, stdout: "Pages: 1\n", stderr: "" };
  if (executable === "pdftotext") return { code: 0, stdout: "generated document person@example.test +62 812 3456 7890", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};
const dataDir = await mkdtemp(join(tmpdir(), "pjs-tracker-browser-"));
await writeSettings(dataDir, smokeSettings);
const smokeProfile = createEmptyProfile();
smokeProfile.identity.headline = "Backend Engineer";
smokeProfile.identity.email = "person@example.test";
smokeProfile.identity.phone = "+62 812 3456 7890";
smokeProfile.identity.summary = "TypeScript backend engineer focused on reliable services. ".repeat(250);
await writeStructuredProfile(dataDir, smokeProfile);
const db = openDatabase(":memory:");
persistScrape(db, { jobs: fixtures });
const seededJob = listJobs(db).find((job) => job.source_id === fixtures[0].sourceId);
if (!seededJob) throw new Error("Tracker smoke fixture job was not persisted");
for (const stage of ["Selected", "Drafting", "Ready", "Applied"] as const) setJobStage(db, seededJob.id, stage);
const selectedJob = listJobs(db).find((job) => job.source_id === fixtures[1].sourceId);
if (!selectedJob) throw new Error("Tracker smoke second fixture job was not persisted");
setJobStage(db, selectedJob.id, "Selected");

const app = await buildServer({
  dataDir,
  db,
  documentStatusRunner: fakeRunner,
  commandRunner: generationRunner,
  strategist: async (input: RunStrategistInput): Promise<ApplicationStrategy> => {
    const ref = input.context.evidenceBank.items[0]!.ref;
    return { positioning: "Backend engineer.", targetRole: "Engineer", primarySellingPoints: [{ angle: "Reliable services", evidenceRefs: [ref] }], requirements: [{ requirement: "Backend", importance: "critical", candidateFit: "strong", evidenceRefs: [ref] }], narrativeGuidance: ["Lead with reliable services."], deEmphasize: [], genuineGaps: [], rankDisagreements: [] };
  },
  writer: async (input: RunWriterInput): Promise<CVDocument> => {
    const ref = input.context.evidenceBank.items[0]!.ref;
    return { summary: { text: "Backend engineer.", evidenceRefs: [ref] }, experiences: [], skillIds: [], projects: [], coverLetter: { subject: "Engineer", paragraphs: [{ text: "I build reliable services.", evidenceRefs: [ref] }] } };
  },
  auditor: async () => ({ issues: [] }),
  critic: async () => ({ score: 8, issues: [], summary: "Ready." }),
  availableModels: async () => [{ id: "fixture", name: "Fixture" }],
  manualImporter: async () => manualImportFixture,
  projectRoot: process.cwd(),
});
let frontend: ChildProcess | undefined;
const browser = await chromium.launch({ headless: true });
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine Tracker smoke API port");
  const frontendPort = await freePort();
  frontend = spawn(process.execPath, [join(process.cwd(), "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(frontendPort)], { cwd: process.cwd(), env: { ...process.env, API_PORT: String(address.port) }, stdio: "ignore", windowsHide: true });
  await waitForFrontend(frontendPort);

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText;
    if (request.url().endsWith("/audio/workflow-run.mp3") && failure === "net::ERR_ABORTED") return;
    requestFailures.push(`${request.url()} — ${failure ?? "unknown"}`);
  });
  const base = `http://127.0.0.1:${frontendPort}`;

  await openTracker(page, base);
  await expect(page).toHaveTitle("TRACKER - Job Sequencer");
  await page.locator(".panel-h").filter({ hasText: "PATTERN 00" }).waitFor();
  await expect(page.locator(".pat-chain")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Arm", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.locator(".transport-meta")).toContainText("Ctrl+K");
  await expect(page.locator(".modes a", { hasText: "SAMPLE" })).toHaveCount(0);
  await expect(page.locator(".workflow-rack")).toBeVisible();
  await page.getByRole("button", { name: "Play scrape" }).click();
  await expect(page.locator(".ask").getByRole("heading", { name: "Start scrape?" })).toBeVisible();
  await page.locator(".ask").getByRole("button", { name: "No" }).click();
  await expect(page.locator(".ask")).toHaveCount(0);

  const routes = [
    { hash: "#/pattern", marker: ".panel-h", text: "PATTERN 00" },
    { hash: "#/order", marker: ".order-panel", text: "ORDER LIST" },
    { hash: `#/phrase/${seededJob.id}`, marker: ".phrase-panel", text: "PHRASE" },
    { hash: `#/sample/${seededJob.id}`, marker: ".sample-panel", text: "SAMPLE" },
    { hash: "#/disk", marker: ".disk-main", text: "DISK" },
    { hash: "#/trace", marker: ".trace-panel", text: "TRACE" },
  ];

  for (const route of routes) {
    await openTracker(page, base, route.hash);
    await page.locator(route.marker).filter({ hasText: route.text }).waitFor({ state: "visible", timeout: 30_000 });
    await assertNoOverflow(page, `desktop ${route.hash}`);
  }

  await openTracker(page, base, "#/pattern");
  await page.getByRole("button", { name: "Collapse workflow rack" }).click();
  await expect(page.getByRole("button", { name: "Open workflow rack" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#workflow-rack")).toBeHidden();
  await page.getByRole("button", { name: "Open workflow rack" }).click();
  await expect(page.locator("#workflow-rack")).toBeVisible();
  const patternTable = page.getByRole("table", { name: /Job pattern/ });
  const fitHeader = patternTable.locator("th", { hasText: "FIT" });
  await expect(fitHeader).toHaveAttribute("aria-sort", "none");
  await expect(fitHeader.getByRole("button", { name: "FIT" })).toBeVisible();
  await expect(patternTable.locator("th", { hasText: "ROW" }).getByRole("button")).toHaveCount(0);
  await patternTable.getByRole("button", { name: "FIT" }).click();
  await expect(fitHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(fitHeader.getByRole("button")).toContainText("↑");
  await expect(patternTable.locator("tbody tr").first().locator("td.fit")).toContainText("72");
  await patternTable.getByRole("button", { name: "FIT" }).click();
  await expect(fitHeader).toHaveAttribute("aria-sort", "descending");
  await expect(fitHeader.getByRole("button")).toContainText("↓");
  await expect(patternTable.locator("tbody tr").first().locator("td.fit")).toContainText("88");
  await page.locator(".agent").waitFor();
  const agentSeparator = page.getByRole("separator", { name: "Resize agent panel" });
  await agentSeparator.focus();
  await agentSeparator.press("ArrowLeft");
  await expect(agentSeparator).toHaveAttribute("aria-valuenow", "296");
  await agentSeparator.press("Home");
  await expect(agentSeparator).toHaveAttribute("aria-valuenow", "260");
  await agentSeparator.press("End");
  await expect(agentSeparator).toHaveAttribute("aria-valuenow", "420");
  await page.getByRole("button", { name: "Collapse agent panel" }).click();
  await expect(page.getByRole("button", { name: "Open agent panel" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#agent-panel")).toBeHidden();
  await agentSeparator.focus();
  await agentSeparator.press("ArrowRight");
  await expect(page.locator("#agent-panel")).toBeVisible();
  const agentBeforeDrag = Number(await agentSeparator.getAttribute("aria-valuenow"));
  const agentSeparatorBox = await agentSeparator.boundingBox();
  if (!agentSeparatorBox) throw new Error("Tracker AGENT resize affordance has no box");
  await page.mouse.move(agentSeparatorBox.x + agentSeparatorBox.width / 2, agentSeparatorBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(agentSeparatorBox.x - 32, agentSeparatorBox.y + 12);
  await page.mouse.up();
  await expect.poll(async () => Number(await agentSeparator.getAttribute("aria-valuenow"))).toBeGreaterThan(agentBeforeDrag);

  const addJob = page.getByRole("button", { name: "ADD JOB" });
  await expect(addJob).toBeVisible();
  await addJob.click();
  const manualDialog = page.getByRole("dialog", { name: "Add job manually" });
  await expect(manualDialog).toBeVisible();
  const manualInput = page.getByLabel("Job URL or pasted posting");
  await expect(manualInput).toBeVisible();
  await manualDialog.getByRole("button", { name: "Add job", exact: true }).click();
  await expect(manualDialog.getByRole("alert")).toContainText("Enter a posting URL or paste job text.");
  await page.keyboard.press("Escape");
  await expect(manualDialog).toBeHidden();
  await addJob.click();
  await manualInput.fill(manualPostingFixture);
  await manualDialog.getByRole("button", { name: "Add job", exact: true }).click();
  await expect(manualDialog).toBeHidden();
  await expect(patternTable.locator("tbody tr").filter({ hasText: "Tracker Manual" })).toBeVisible({ timeout: 30_000 });

  await openTracker(page, base, `#/sample/${seededJob.id}`);
  await expect(page.locator(".modes a", { hasText: "SAMPLE" })).toBeVisible();
  await page.locator(".sample-aside").waitFor();
  await expect(page.locator(".sample-panel .sample-verification")).toHaveCount(1);
  await expect(page.locator(".sample-panel .sample-document-summary")).toHaveCount(0);
  await expect(page.locator(".sample-aside .sample-document-summary")).toHaveCount(1);
  const separator = page.getByRole("separator", { name: "Resize inspector" });
  await separator.focus();
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "296");
  await page.getByRole("button", { name: "Collapse inspector" }).click();
  await expect(page.getByRole("button", { name: "Open inspector" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#sample-inspector")).toBeHidden();
  await separator.focus();
  await separator.press("ArrowLeft");
  await expect(page.locator("#sample-inspector")).toBeVisible();
  const beforeDrag = Number(await separator.getAttribute("aria-valuenow"));
  const separatorBox = await separator.boundingBox();
  if (!separatorBox) throw new Error("Tracker inspector resize affordance has no box");
  await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(separatorBox.x - 32, separatorBox.y + 12);
  await page.mouse.up();
  await expect.poll(async () => Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThan(beforeDrag);

  await openTracker(page, base, "#/disk");
  await page.locator(".disk-tune-panel").waitFor();
  const diskSeparator = page.getByRole("separator", { name: "Resize fine-tune sidebar" });
  await diskSeparator.focus();
  await diskSeparator.press("ArrowLeft");
  await expect(diskSeparator).toHaveAttribute("aria-valuenow", "296");
  await page.getByRole("button", { name: "Collapse fine-tune sidebar" }).click();
  await expect(page.getByRole("button", { name: "Open fine-tune sidebar" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#disk-tune")).toBeHidden();
  await diskSeparator.focus();
  await diskSeparator.press("ArrowRight");
  await expect(page.locator("#disk-tune")).toBeVisible();
  const diskBeforeDrag = Number(await diskSeparator.getAttribute("aria-valuenow"));
  const diskSeparatorBox = await diskSeparator.boundingBox();
  if (!diskSeparatorBox) throw new Error("Tracker DISK resize affordance has no box");
  await page.mouse.move(diskSeparatorBox.x + diskSeparatorBox.width / 2, diskSeparatorBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(diskSeparatorBox.x - 32, diskSeparatorBox.y + 12);
  await page.mouse.up();
  await expect.poll(async () => Number(await diskSeparator.getAttribute("aria-valuenow"))).toBeGreaterThan(diskBeforeDrag);

  await openTracker(page, base, "#/order");
  await page.locator(".order-board").waitFor();
  await expect(page.locator(".reco")).toContainText("Generate");
  await expect(page.locator(".reco button", { hasText: "Accept · generate" })).toBeVisible();
  await expect(page.locator(".reco .conf")).toHaveCount(0);
  const desktopBoard = await page.locator(".order-list").evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  if (desktopBoard.scrollWidth <= desktopBoard.clientWidth) throw new Error(`ORDER board is not horizontally scrollable: ${JSON.stringify(desktopBoard)}`);

  await openTracker(page, base, `#/sample/${selectedJob.id}`);
  await page.locator(".sample-aside").waitFor();
  const pageOverride = page.getByLabel("Maximum CV pages");
  await expect(pageOverride).toHaveValue("");
  await expect(page.locator(".sample-page-meta")).toContainText("Inherited from DISK");
  await pageOverride.fill("1");
  await pageOverride.blur();
  await expect(page.locator(".sample-page-meta")).toContainText("Override: 1");
  await expect(page.locator(".sample-page-warning")).toContainText("Complete profile is estimated");
  await page.getByLabel("CV length").selectOption("short");
  await expect(page.locator(".sample-page-warning")).toHaveCount(0);
  await page.getByLabel("CV length").selectOption("complete");
  await expect(page.locator(".sample-page-warning")).toContainText("may shorten the CV to fit");
  const generateDocuments = page.getByRole("button", { name: "Generate documents", exact: true });
  await expect(generateDocuments).toBeEnabled();
  await generateDocuments.click();
  await expect(page.getByRole("button", { name: "Revise", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Revise", exact: true }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${base}/api/jobs/${selectedJob.id}`);
    return (await response.json()).generation_direction.revisionCount;
  }, { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole("button", { name: "Revise", exact: true })).toBeEnabled({ timeout: 30_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of routes) {
    await openTracker(page, base, route.hash);
    await page.locator(route.marker).filter({ hasText: route.text }).waitFor({ state: "visible", timeout: 30_000 });
    await assertNoOverflow(page, `mobile ${route.hash}`);
  }
  await openTracker(page, base, "#/order");
  await page.locator(".order-board").waitFor();
  const mobileBoard = await page.locator(".order-list").evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  if (mobileBoard.scrollWidth <= mobileBoard.clientWidth) throw new Error(`Mobile ORDER board is not horizontally scrollable: ${JSON.stringify(mobileBoard)}`);
  await assertNoOverflow(page, "mobile order board");
  await openTracker(page, base, "#/disk");
  const mobileDiskMainLocator = page.locator(".disk-main");
  const mobileDiskTuneLocator = page.locator(".disk-tune-panel");
  await Promise.all([
    mobileDiskMainLocator.waitFor({ state: "visible", timeout: 30_000 }),
    mobileDiskTuneLocator.waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  const mobileDiskMain = await mobileDiskMainLocator.boundingBox();
  const mobileDiskTune = await mobileDiskTuneLocator.boundingBox();
  if (!mobileDiskMain || !mobileDiskTune || mobileDiskTune.y < mobileDiskMain.y + mobileDiskMain.height - 1) throw new Error("DISK sidebar did not stack below the editor on mobile");
  if (mobileDiskTune.width > 390) throw new Error(`DISK sidebar exceeds mobile viewport: ${JSON.stringify(mobileDiskTune)}`);
  await assertNoOverflow(page, "mobile disk sidebar");

  if (consoleErrors.length || pageErrors.length || requestFailures.length) {
    throw new Error(JSON.stringify({ consoleErrors, pageErrors, requestFailures }));
  }
  console.log(JSON.stringify({ ok: true, root: "/", routes: routes.map((route) => route.hash), consoleErrors: 0, pageErrors: 0, requestFailures: 0, responsive: { desktop: "checked", mobile: "checked" } }));
} finally {
  await browser.close();
  if (frontend) { frontend.kill(); await delay(50); }
  await app.close();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
}
