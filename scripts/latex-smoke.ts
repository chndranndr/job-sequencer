import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { latexSmokeCommands, runCommand } from "../src/server/documents.js";

const dir = join(process.cwd(), ".tmp-phase0-latex");
const tex = "smoke.tex";
await mkdir(dir, { recursive: true });
await writeFile(join(dir, tex), "\\documentclass{article}\\begin{document}Phase 0 PDF smoke.\\end{document}\\n", "utf8");
try {
  const commands = latexSmokeCommands(tex).map(([executable, args]) =>
    executable === "lualatex" || executable === "xelatex"
      ? [executable, [...args, "-halt-on-error"]] as [string, string[]]
      : [executable, args] as [string, string[]],
  );
  for (const [executable, args] of commands) {
    try {
      const result = await runCommand(executable, args, 30_000, dir);
      console.log(`${executable}: exit=${result.code}`);
      if (result.code !== 0) process.exitCode = 1;
    } catch (error) {
      console.log(`${executable}: blocked=${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
