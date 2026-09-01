import { access, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CVDocument } from "./agents/types.js";
import { runCommand, type CommandRunner } from "./documents.js";

export type VisualReview = { status: "passed" | "needs_review"; issues: string[]; summary: string };
export type VisualQaInput = { pagePaths: string[]; document: CVDocument; signal?: AbortSignal };
export type VisualQaFn = (input: VisualQaInput) => Promise<VisualReview>;

export async function rasterizePdfPages(input: { currentDir: string; runner?: CommandRunner; signal?: AbortSignal }) {
  const runner = input.runner ?? runCommand;
  const visualDir = join(input.currentDir, "visual");
  await mkdir(visualDir, { recursive: true });
  const pages: string[] = [];
  for (const [pdf, prefix] of [["cv.pdf", "cv-page"], ["cover-letter.pdf", "letter-page"]] as const) {
    try {
      await access(join(input.currentDir, pdf));
      const result = await runner("pdftoppm", ["-png", "-r", "120", pdf, join(visualDir, prefix)], 30_000, input.currentDir, input.signal);
      if (result.code !== 0) return { status: "skipped" as const, pages: [] };
    } catch {
      return { status: "skipped" as const, pages: [] };
    }
  }
  for (const name of await readdir(visualDir)) if (/\.png$/i.test(name)) pages.push(join(visualDir, name));
  return pages.length ? { status: "ready" as const, pages: pages.sort() } : { status: "skipped" as const, pages: [] };
}
