import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright";
import { buildServer } from "../../../../src/server/app.js";

type Role =
  | "alert" | "button" | "checkbox" | "dialog" | "heading" | "link" | "list"
  | "navigation" | "searchbox" | "separator" | "status" | "tab" | "table"
  | "textbox";

type State = {
  controlUrl: string;
  frontendUrl: string;
  apiUrl: string;
  dataDir: string;
  servePid: number;
  frontendPid?: number;
  startedAt: string;
};

type Rpc =
  | { op: "doctor" }
  | { op: "goto"; hash?: string }
  | { op: "click"; role: Role; name: string; exact?: boolean }
  | { op: "fill"; label: string; value: string }
  | { op: "press"; key: string }
  | { op: "waitText"; text: string; timeoutMs?: number }
  | { op: "title" }
  | { op: "text" }
  | { op: "snapshot"; path?: string }
  | { op: "screenshot"; path?: string }
  | { op: "api"; method?: string; path: string; body?: string }
  | { op: "shutdown" };

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../../../");
const ARTIFACTS = join(ROOT, "artifacts", "verify-job-sequencer");
const STATE_PATH = join(ARTIFACTS, "run-state.json");
const LOG_PATH = join(ARTIFACTS, "serve.log");
const CONTROL = process.env.VERIFY_JOB_SEQUENCER_CONTROL;
const argv = process.argv.slice(2);
const command = argv[0] ?? "help";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flags(args: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function flag(args: ReturnType<typeof flags>, name: string) {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

async function freePort() {
  const probe = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function containedArtifact(path: string) {
  const resolved = resolve(isAbsolute(path) ? path : join(ARTIFACTS, "proof", path));
  const rel = relative(ARTIFACTS, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refusing to write outside ${ARTIFACTS}: ${path}`);
  return resolved;
}

async function readState(): Promise<State> {
  if (!existsSync(STATE_PATH)) fail(`No verification instance. Run launch first (${STATE_PATH} missing).`);
  return JSON.parse(await readFile(STATE_PATH, "utf8")) as State;
}

async function writeState(state: State) {
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function rpc(state: State, body: Rpc) {
  const response = await fetch(`${state.controlUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: { ok: boolean; error?: string; [key: string]: unknown };
  try { parsed = JSON.parse(text) as typeof parsed; }
  catch { throw new Error(`Control RPC ${body.op} returned non-JSON (${response.status}): ${text.slice(0, 400)}`); }
  if (!response.ok || parsed.ok === false) throw new Error(parsed.error ?? `Control RPC ${body.op} failed (${response.status}).`);
  return parsed;
}

async function jsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Rpc;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function userDataDir() {
  return join(ROOT, "data") + sep;
}

function assertIsolated(dataDir: string, frontendUrl: string, apiUrl: string) {
  const normalized = resolve(dataDir) + sep;
  if (normalized.toLowerCase() === userDataDir().toLowerCase() || normalized.toLowerCase().startsWith(userDataDir().toLowerCase())) {
    throw new Error(`Refusing to drive the shared project data directory (${dataDir}). Launch an isolated instance.`);
  }
  if (frontendUrl.includes(":5173") && apiUrl.includes(":3000")) {
    throw new Error("Refusing to drive the default user ports 5173/3000. Launch an isolated instance.");
  }
}

async function waitForOk(url: string, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* still starting */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function help() {
  console.log(`control-job-sequencer — isolated Job Sequencer verification helper

Usage (from repo root):
  npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts <command>

Commands:
  launch                         Start an isolated API + Vite + Chromium (never 3000/5173 or ./data)
  doctor                         Confirm this run's instance is healthy and isolated
  cleanup                        Stop PIDs this run started; keep artifacts/verify-job-sequencer/proof
  browser goto --hash "#/disk"
  browser click --role button --name "ADD JOB" [--exact]
  browser fill --label "First name" --value "Ada"
  browser press --key Escape
  browser wait --text "PATTERN 00"
  browser title
  browser text
  browser snapshot --path tracker-shell/pattern.aria.txt
  browser screenshot --path tracker-shell/pattern.png
  api --method GET --path /api/profile
`);
}

async function runLaunch() {
  if (!existsSync(join(ROOT, "node_modules", "playwright"))) fail("Run npm ci first.");
  await mkdir(ARTIFACTS, { recursive: true });
  if (existsSync(STATE_PATH)) {
    try { await rpc(await readState(), { op: "shutdown" }); } catch { /* stale state */ }
    await rm(STATE_PATH, { force: true });
  }
  const child = spawn(process.execPath, ["--import=tsx", fileURLToPath(import.meta.url), "serve"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
    env: { ...process.env },
  });
  if (!child.pid) fail("Failed to spawn the verification serve process.");
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (existsSync(STATE_PATH)) {
      try {
        const state = await readState();
        const health = await rpc(state, { op: "doctor" });
        console.log(JSON.stringify({ ok: true, ...state, doctor: health }, null, 2));
        return;
      } catch { /* serve still booting */ }
    }
    await delay(200);
  }
  fail(`Launch timed out. Inspect ${LOG_PATH}.`);
}

async function runServe() {
  await mkdir(ARTIFACTS, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), "job-sequencer-verify-"));
  const app = await buildServer({ dataDir, projectRoot: ROOT });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const apiAddress = app.server.address();
  if (!apiAddress || typeof apiAddress === "string") throw new Error("Could not determine isolated API port.");
  const frontendPort = await freePort();
  const controlPort = await freePort();
  const frontend = spawn(
    process.execPath,
    [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"],
    { cwd: ROOT, env: { ...process.env, API_PORT: String(apiAddress.port) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const logChunks: string[] = [];
  frontend.stdout?.on("data", (chunk) => { logChunks.push(String(chunk)); });
  frontend.stderr?.on("data", (chunk) => { logChunks.push(String(chunk)); });
  await waitForOk(`http://127.0.0.1:${frontendPort}/`);
  const browser: Browser = await chromium.launch({ headless: true });
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const apiUrl = `http://127.0.0.1:${apiAddress.port}`;
  const controlUrl = `http://127.0.0.1:${controlPort}`;
  await page.goto(`${frontendUrl}/#/pattern`);
  await page.locator(".studio").waitFor();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await browser.close(); } catch { /* already closed */ }
    if (frontend.pid) { try { frontend.kill(); } catch { /* already dead */ } }
    try { await app.close(); } catch { /* already closed */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(STATE_PATH, { force: true });
    process.exit(0);
  };

  const control = createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/rpc") return send(res, 404, { ok: false, error: "Unknown control route." });
    try {
      const body = await jsonBody(req);
      if (body.op === "shutdown") {
        send(res, 200, { ok: true });
        await delay(50);
        await shutdown();
        return;
      }
      send(res, 200, { ok: true, ...(await handleRpc(body, { page, frontendUrl, apiUrl, dataDir, frontend, logChunks })) });
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolveListen) => control.listen(controlPort, "127.0.0.1", () => resolveListen()));
  await writeState({
    controlUrl,
    frontendUrl,
    apiUrl,
    dataDir,
    servePid: process.pid,
    frontendPid: frontend.pid,
    startedAt: new Date().toISOString(),
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function handleRpc(body: Rpc, ctx: {
  page: Page;
  frontendUrl: string;
  apiUrl: string;
  dataDir: string;
  frontend: ChildProcess;
  logChunks: string[];
}) {
  const { page, frontendUrl, apiUrl, dataDir, frontend } = ctx;
  switch (body.op) {
    case "doctor": {
      assertIsolated(dataDir, frontendUrl, apiUrl);
      const health = await fetch(`${apiUrl}/health`).then((response) => response.json()) as { ok?: boolean; service?: string };
      const front = await fetch(`${frontendUrl}/`);
      const proxied = await fetch(`${frontendUrl}/health`).then((response) => response.json()) as { ok?: boolean; service?: string };
      if (health.ok !== true || health.service !== "job-sequencer") throw new Error(`API /health unexpected: ${JSON.stringify(health)}`);
      if (!front.ok) throw new Error(`Frontend GET / returned ${front.status}`);
      if (proxied.service !== "job-sequencer") throw new Error("Vite /health proxy is not this Job Sequencer API.");
      if (!frontend.pid) throw new Error("Vite child PID is missing.");
      await page.locator(".studio").waitFor({ timeout: 5_000 });
      return {
        title: await page.title(),
        url: page.url(),
        health,
        dataDir,
        frontendUrl,
        apiUrl,
        isolated: true,
      };
    }
    case "goto": {
      const hash = body.hash ?? "#/pattern";
      await page.goto(`${frontendUrl}/${hash.startsWith("#") ? hash : `#${hash}`}`);
      await page.locator(".studio").waitFor();
      return { url: page.url(), title: await page.title() };
    }
    case "click": {
      const locator = page.getByRole(body.role, { name: body.exact ? body.name : new RegExp(body.name, "i"), exact: body.exact });
      await locator.first().click();
      return { clicked: body.name };
    }
    case "fill": {
      await page.getByLabel(body.label, { exact: true }).fill(body.value);
      return { label: body.label };
    }
    case "press": {
      await page.keyboard.press(body.key);
      return { key: body.key };
    }
    case "waitText": {
      await page.getByText(body.text, { exact: false }).first().waitFor({ timeout: body.timeoutMs ?? 15_000 });
      return { text: body.text };
    }
    case "title":
      return { title: await page.title(), url: page.url() };
    case "text":
      return { text: await page.locator("body").innerText() };
    case "snapshot": {
      const aria = await page.locator("body").ariaSnapshot();
      if (body.path) {
        const target = containedArtifact(body.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, `${aria}\n`, "utf8");
        return { path: target, aria };
      }
      return { aria };
    }
    case "screenshot": {
      const target = containedArtifact(body.path ?? `screenshot-${Date.now()}.png`);
      await mkdir(dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage: true });
      return { path: target };
    }
    case "api": {
      const method = (body.method ?? "GET").toUpperCase();
      const response = await fetch(`${frontendUrl}${body.path}`, {
        method,
        headers: body.body ? { "content-type": "application/json" } : undefined,
        body: body.body,
      });
      const text = await response.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      if (!response.ok) throw new Error(`API ${method} ${body.path} failed (${response.status}): ${text.slice(0, 400)}`);
      return { status: response.status, body: parsed };
    }
    default:
      throw new Error(`Unknown RPC ${(body as Rpc).op}`);
  }
}

async function killPid(pid: number) {
  try { process.kill(pid); }
  catch {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
  }
}

async function runCleanup() {
  if (!existsSync(STATE_PATH)) {
    console.log(JSON.stringify({ ok: true, skipped: "no run-state" }));
    return;
  }
  const state = await readState();
  try { await rpc(state, { op: "shutdown" }); }
  catch {
    if (state.frontendPid) await killPid(state.frontendPid);
    await killPid(state.servePid);
    await rm(state.dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(STATE_PATH, { force: true });
  }
  for (let i = 0; i < 40 && existsSync(STATE_PATH); i++) await delay(100);
  console.log(JSON.stringify({
    ok: true,
    stopped: { servePid: state.servePid, frontendPid: state.frontendPid },
    dataDirRemoved: !existsSync(state.dataDir),
    proofKept: join(ARTIFACTS, "proof"),
  }));
}

async function runDoctor() {
  const state = await readState();
  assertIsolated(state.dataDir, state.frontendUrl, state.apiUrl);
  const result = await rpc(state, { op: "doctor" });
  console.log(JSON.stringify({ ok: true, ...state, ...result }, null, 2));
}

async function runBrowser(kind: string, args: ReturnType<typeof flags>) {
  const state = await readState();
  if (kind === "goto") return console.log(JSON.stringify(await rpc(state, { op: "goto", hash: flag(args, "hash") ?? "#/pattern" })));
  if (kind === "click") {
    const role = flag(args, "role") as Role | undefined;
    const name = flag(args, "name");
    if (!role || !name) fail("browser click requires --role and --name");
    return console.log(JSON.stringify(await rpc(state, { op: "click", role, name, exact: args.exact === true })));
  }
  if (kind === "fill") {
    const label = flag(args, "label");
    const value = flag(args, "value");
    if (label === undefined || value === undefined) fail("browser fill requires --label and --value");
    return console.log(JSON.stringify(await rpc(state, { op: "fill", label, value })));
  }
  if (kind === "press") {
    const key = flag(args, "key");
    if (!key) fail("browser press requires --key");
    return console.log(JSON.stringify(await rpc(state, { op: "press", key })));
  }
  if (kind === "wait") {
    const text = flag(args, "text");
    if (!text) fail("browser wait requires --text");
    return console.log(JSON.stringify(await rpc(state, { op: "waitText", text })));
  }
  if (kind === "title") return console.log(JSON.stringify(await rpc(state, { op: "title" })));
  if (kind === "text") return console.log(JSON.stringify(await rpc(state, { op: "text" })));
  if (kind === "snapshot") return console.log(JSON.stringify(await rpc(state, { op: "snapshot", path: flag(args, "path") })));
  if (kind === "screenshot") return console.log(JSON.stringify(await rpc(state, { op: "screenshot", path: flag(args, "path") })));
  fail(`Unknown browser subcommand: ${kind}`);
}

try {
  if (command === "help" || command === "--help" || command === "-h") help();
  else if (command === "serve") await runServe();
  else if (command === "launch") await runLaunch();
  else if (command === "doctor") await runDoctor();
  else if (command === "cleanup") await runCleanup();
  else if (command === "browser") await runBrowser(argv[1] ?? "", flags(argv.slice(2)));
  else if (command === "api") {
    const args = flags(argv.slice(1));
    const path = flag(args, "path");
    if (!path) fail("api requires --path");
    console.log(JSON.stringify(await rpc(await readState(), { op: "api", method: flag(args, "method") ?? "GET", path, body: flag(args, "body") }), null, 2));
  } else fail(`Unknown command: ${command}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
