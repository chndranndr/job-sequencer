#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const markdownRoots = ["AGENTS.md", "README.md", "IDEA.md", "docs"];
const ignoredDirectories = new Set([".git", "node_modules", "dist", "vendor", "data", "artifacts"]);

async function filesBelow(path: string, extensions?: Set<string>): Promise<string[]> {
  if (!existsSync(path)) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(target, extensions));
    else if (!extensions || extensions.has(extname(entry.name))) files.push(target);
  }
  return files;
}

async function markdownFiles(base = root) {
  const files: string[] = [];
  for (const entry of markdownRoots) {
    const target = join(base, entry);
    if (!existsSync(target)) continue;
    if (extname(target) === ".md") files.push(target);
    else files.push(...await filesBelow(target, new Set([".md"])));
  }
  return files;
}

export async function findBrokenMarkdownLinks(base = root, files?: string[]) {
  const broken: string[] = [];
  for (const file of files ?? await markdownFiles(base)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, "");
      if (!raw || raw.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(raw)) continue;
      const path = decodeURIComponent(raw.split("#", 1)[0]);
      if (path && !existsSync(resolve(dirname(file), path))) {
        broken.push(`${relative(base, file)} -> ${raw}`.replaceAll("\\", "/"));
      }
    }
  }
  return broken;
}

export async function findArchitectureViolations(base = root) {
  const violations: string[] = [];
  const boundaries = [
    { source: join(base, "src", "server"), forbidden: join(base, "src", "tracker"), label: "server -> tracker" },
    { source: join(base, "src", "tracker"), forbidden: join(base, "src", "server"), label: "tracker -> server" },
  ];
  for (const boundary of boundaries) {
    for (const file of await filesBelow(boundary.source, new Set([".ts", ".tsx"]))) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
        if (!match[1].startsWith(".")) continue;
        const imported = resolve(dirname(file), match[1]);
        if (imported === boundary.forbidden || imported.startsWith(`${boundary.forbidden}\\`) || imported.startsWith(`${boundary.forbidden}/`)) {
          violations.push(`${relative(base, file)}: ${boundary.label}`.replaceAll("\\", "/"));
        }
      }
    }
  }
  return violations;
}

async function validateManifest(base = root) {
  const path = join(base, ".harness", "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    schema_version?: number;
    profile?: string;
    managed_artifacts?: string[];
    commands?: Record<string, string | null>;
  };
  const expectedCommands = ["setup", "dev", "format", "check", "test", "eval", "doctor", "gc"];
  if (manifest.schema_version !== 1 || manifest.profile !== "standard") throw new Error("Harness manifest schema/profile mismatch.");
  if (JSON.stringify(Object.keys(manifest.commands ?? {})) !== JSON.stringify(expectedCommands)) throw new Error("Harness manifest command slots drifted.");
  for (const artifact of manifest.managed_artifacts ?? []) {
    if (!existsSync(join(base, artifact))) throw new Error(`Managed artifact is missing: ${artifact}`);
  }
}

export async function checkHarness(base = root) {
  const problems = [
    ...(await findBrokenMarkdownLinks(base)).map(value => `broken link: ${value}`),
    ...(await findArchitectureViolations(base)).map(value => `architecture: ${value}`),
  ];
  try { await validateManifest(base); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(JSON.stringify({ ok: true, checks: ["manifest", "documentation-links", "architecture-boundaries"] }));
}

function run(command: string, args: string[]) {
  const result = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `${command}.cmd ${args.join(" ")}`], { cwd: root, stdio: "inherit" })
    : spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(result.error?.message ?? `${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.`);
}

async function doctor() {
  await checkHarness();
  run("npm", ["run", "format"]);
  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);
  run("npm", ["run", "eval"]);
}

async function garbageCollect(dryRun: boolean) {
  const targets = ["dist", "coverage", ".vite"].map(path => join(root, path)).filter(existsSync);
  const tsBuildInfo = (await readdir(root)).filter(name => name.endsWith(".tsbuildinfo")).map(name => join(root, name));
  const found = [...targets, ...tsBuildInfo];
  if (!dryRun) for (const target of found) await rm(target, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, dryRun, targets: found.map(path => relative(root, path).replaceAll("\\", "/")) }));
}

async function main() {
  const command = process.argv[2] ?? "check";
  if (command === "check") return checkHarness();
  if (command === "doctor") return doctor();
  if (command === "gc") return garbageCollect(process.argv.includes("--dry-run"));
  throw new Error(`Unknown harness command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
