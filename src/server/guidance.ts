import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const guidanceFiles = {
  searchQueries: "job-scraper/search-queries.md",
  evaluation: "job-application-assistant/04-job-evaluation.md",
  writingStyle: "job-application-assistant/03-writing-style.md",
  cvTemplates: "job-application-assistant/05-cv-templates.md",
  coverLetterTemplates: "job-application-assistant/06-cover-letter-templates.md",
  interviewPrep: "job-application-assistant/07-interview-prep.md",
} as const;

export type GuidanceKey = keyof typeof guidanceFiles;

const maxGuidanceBytes = 80_000;

function stripOperationalContent(value: string) {
  return value
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/```(?:yaml|yml)[\s\S]*?```/gi, "")
    .slice(0, maxGuidanceBytes);
}

export async function loadGuidance(keys: readonly GuidanceKey[], vendorRoot = resolve(process.cwd(), "vendor", "ai-job-search-skills")) {
  for (const key of keys) if (!(key in guidanceFiles)) throw new Error(`Guidance file is not in the runtime allowlist: ${String(key)}`);
  const selected = await Promise.all(keys.map(async (key) => {
    const relativePath = guidanceFiles[key];
    const path = resolve(vendorRoot, relativePath);
    if (relative(resolve(vendorRoot), path).startsWith(`..${sep}`) || relative(resolve(vendorRoot), path) === "..") throw new Error("Guidance path escaped the vendored skills directory.");
    try {
      const body = await readFile(path, "utf8");
      return `## ${relativePath}\n${stripOperationalContent(body)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Required guidance file is missing: ${relativePath}`);
      throw error;
    }
  }));
  return selected.join("\n\n");
}
