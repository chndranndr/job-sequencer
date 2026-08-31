import { spawn, spawnSync, execSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

type Target = "api" | "frontend";
type PendingState = { triggeredAt: number; targets: Target[] };
type HookInput = { file_path?: string; workspace_roots?: string[] };

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const STATE_PATH = joinPath(here, ".restart-dev-state.json");
const RUNNER_PID_PATH = joinPath(here, ".restart-dev-runner.pid");
const API_PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3000);
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);
const DEBOUNCE_MS = 2000;

function joinPath(...parts: string[]) {
  return resolve(...parts);
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function log(message: string) {
  console.error(`[restart-dev] ${message}`);
}

function relPath(filePath: string, workspaceRoots: string[] = []) {
  const normalized = resolve(filePath);
  const roots = [ROOT, ...workspaceRoots.map((root) => resolve(root))].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const rel = relative(root, normalized).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..")) return rel;
  }
  return normalized.replace(/\\/g, "/");
}

function classifyPath(rel: string): Target[] {
  if (!rel || rel.startsWith("tests/") || rel.startsWith("vendor/") || rel.startsWith("docs/") || rel.startsWith(".audit/")) return [];
  if (rel.startsWith(".cursor/hooks/") || rel.startsWith("dist/") || rel.endsWith(".log")) return [];

  const targets = new Set<Target>();
  const api = [/^src\/server\//, /^tsconfig\.server\.json$/];
  const frontend = [/^src\/tracker\//, /^src\/profile-editor/, /^vite\.config\.ts$/, /^index\.html$/, /^tracker\.html$/, /\.css$/];
  const both = [/^src\/shared/, /^package\.json$/, /^package-lock\.json$/];

  if (api.some((pattern) => pattern.test(rel))) targets.add("api");
  if (frontend.some((pattern) => pattern.test(rel))) targets.add("frontend");
  if (both.some((pattern) => pattern.test(rel))) {
    targets.add("api");
    targets.add("frontend");
  }
  if (!targets.size && /^src\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) {
    targets.add("api");
    targets.add("frontend");
  }
  return [...targets];
}

function readState(): PendingState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as PendingState;
  } catch {
    return null;
  }
}

function writeState(state: PendingState) {
  writeFileSync(STATE_PATH, `${JSON.stringify(state)}\n`, "utf8");
}

function clearState() {
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
}

function runnerActive() {
  if (!existsSync(RUNNER_PID_PATH)) return false;
  const pid = Number(readFileSync(RUNNER_PID_PATH, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    unlinkSync(RUNNER_PID_PATH);
    return false;
  }
}

function spawnRunner(mode: "--run-pending" | "--flush") {
  const child = spawn(process.execPath, ["--import=tsx", fileURLToPath(import.meta.url), mode], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  if (!child.pid) return;
  writeFileSync(RUNNER_PID_PATH, `${child.pid}\n`, "utf8");
  child.unref();
}

function queueTargets(targets: Target[]) {
  if (!targets.length) return;
  const now = Date.now();
  const current = readState();
  const merged = new Set<Target>(current?.targets ?? []);
  for (const target of targets) merged.add(target);
  writeState({ triggeredAt: now, targets: [...merged] });
  if (!runnerActive()) spawnRunner("--run-pending");
}

async function portOpen(port: number) {
  return new Promise<boolean>((resolveOpen) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once("error", () => resolveOpen(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolveOpen(false);
    });
  });
}

async function apiHealthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${API_PORT}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean; service?: string };
    return body.ok === true && body.service === "job-sequencer";
  } catch {
    return false;
  }
}

async function viteHealthy() {
  try {
    const response = await fetch(`http://127.0.0.1:${VITE_PORT}/`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function killPort(port: number) {
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes("LISTENING") || !line.includes(`:${port}`)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts.at(-1));
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* already dead */ }
      }
      return pids.size > 0;
    }
    execSync(`lsof -ti tcp:${port} | xargs kill -9`, { stdio: "ignore", shell: true });
    return true;
  } catch {
    return false;
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function spawnDetached(args: string[]) {
  const child = spawn(npmCommand(), args, {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
    env: { ...process.env, API_PORT: String(API_PORT) },
  });
  child.unref();
}

async function restartApi() {
  if (!(await apiHealthy()) && !(await portOpen(API_PORT))) {
    log("API not running; skip restart");
    return;
  }
  log("rebuilding server");
  const build = spawnSync(npmCommand(), ["run", "build"], {
    cwd: ROOT,
    stdio: "pipe",
    shell: false,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    log(`build failed (${build.status}); not restarting API`);
    return;
  }
  killPort(API_PORT);
  await delay(300);
  spawnDetached(["start"]);
  log(`API restarted on :${API_PORT}`);
}

async function restartVite() {
  if (!(await viteHealthy()) && !(await portOpen(VITE_PORT))) {
    log("Vite not running; skip restart");
    return;
  }
  killPort(VITE_PORT);
  await delay(300);
  spawnDetached(["run", "dev"]);
  log(`Vite restarted on :${VITE_PORT}`);
}

async function runPending(flush: boolean) {
  if (!flush) {
    await delay(DEBOUNCE_MS);
    const state = readState();
    if (!state) return;
    if (Date.now() - state.triggeredAt < DEBOUNCE_MS - 50) {
      spawnRunner("--run-pending");
      return;
    }
  }

  const state = readState();
  if (!state?.targets.length) {
    clearState();
    if (existsSync(RUNNER_PID_PATH)) unlinkSync(RUNNER_PID_PATH);
    return;
  }

  const targets = new Set(state.targets);
  clearState();
  if (existsSync(RUNNER_PID_PATH)) unlinkSync(RUNNER_PID_PATH);

  if (targets.has("api")) await restartApi();
  if (targets.has("frontend")) await restartVite();
}

async function handleHook() {
  const raw = await readStdin();
  if (!raw) return;
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return;
  }
  if (!input.file_path) return;
  const rel = relPath(input.file_path, input.workspace_roots);
  const targets = classifyPath(rel);
  if (!targets.length) return;
  log(`queued ${targets.join("+")} restart for ${rel}`);
  queueTargets(targets);
}

const mode = process.argv[2] ?? "hook";
if (mode === "--run-pending") {
  runPending(false).catch((error) => log(error instanceof Error ? error.message : String(error)));
} else if (mode === "--flush") {
  runPending(true).catch((error) => log(error instanceof Error ? error.message : String(error)));
} else {
  handleHook().catch((error) => log(error instanceof Error ? error.message : String(error)));
}
