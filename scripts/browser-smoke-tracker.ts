import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { buildServer } from "../src/server/app.js";
import { listJobs, openDatabase, persistScrape, setJobStage } from "../src/server/db.js";
import type { CommandRunner } from "../src/server/documents.js";

const fixture = {
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
const dataDir = await mkdtemp(join(tmpdir(), "pjs-tracker-browser-"));
const db = openDatabase(":memory:");
persistScrape(db, { jobs: [fixture] });
const seededJob = listJobs(db)[0];
if (!seededJob) throw new Error("Tracker smoke fixture job was not persisted");
for (const stage of ["Selected", "Drafting", "Ready", "Applied"] as const) setJobStage(db, seededJob.id, stage);

const app = await buildServer({
  dataDir,
  db,
  documentStatusRunner: fakeRunner,
  availableModels: async () => [{ id: "fixture", name: "Fixture" }],
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
  page.on("requestfailed", (request) => requestFailures.push(`${request.url()} — ${request.failure()?.errorText ?? "unknown"}`));
  const base = `http://127.0.0.1:${frontendPort}`;

  await openTracker(page, base);
  await expect(page).toHaveTitle("TRACKER - Personal Job Search");
  await page.locator(".panel-h").filter({ hasText: "PATTERN 00" }).waitFor();

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

  await openTracker(page, base, `#/sample/${seededJob.id}`);
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
  const desktopBoard = await page.locator(".order-list").evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  if (desktopBoard.scrollWidth <= desktopBoard.clientWidth) throw new Error(`ORDER board is not horizontally scrollable: ${JSON.stringify(desktopBoard)}`);

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
  const mobileDiskMain = await page.locator(".disk-main").boundingBox();
  const mobileDiskTune = await page.locator(".disk-tune-panel").boundingBox();
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
