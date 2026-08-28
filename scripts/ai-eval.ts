#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ponytail: live eval starts with 10 anonymized fixtures; expand after failure categories stabilize.
// ponytail: acceptance thresholds come from labeled fixtures, not one provider run.
async function main() {
  if (process.env.LIVE_AI_EVAL !== "1") {
    console.error("Live provider eval is disabled. Set LIVE_AI_EVAL=1 to run scripts/ai-eval.ts.");
    process.exit(1);
  }
  const fixtureDir = join(process.cwd(), "tests", "fixtures", "ai");
  const fixtures = (await readdir(fixtureDir)).filter((name) => name.endsWith(".json"));
  const report = {
    mode: "live",
    fixtureCount: fixtures.length,
    fixtures: [] as Array<{ id: string; status: "pending_live_hook" }>,
  };
  for (const name of fixtures) {
    const fixture = JSON.parse(await readFile(join(fixtureDir, name), "utf8")) as { id: string };
    report.fixtures.push({ id: fixture.id, status: "pending_live_hook" });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
