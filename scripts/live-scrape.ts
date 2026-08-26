import { createScrapeTools } from "../src/server/scrape.js";
import { readCriteria, readSettings } from "../src/server/config.js";
import { jobSourceLabel, type BuiltInJobSource } from "../src/shared.js";

let source: BuiltInJobSource = "freehire";
try {
  const settings = await readSettings("data");
  source = settings.source;
  const criteria = await readCriteria("data");
  const tools = createScrapeTools({ source: settings.source, maxAgeDays: settings.sourceMaxAgeDays?.[settings.source] });
  const result = await tools.searchJobs.execute("live-search", { query: criteria.roles.join(" ") || "backend engineer", location: criteria.locations[0] ?? "", limit: 5 }, undefined, undefined, undefined as never);
  const block = result.content[0];
  console.log(block.type === "text" ? block.text : "[non-text result]");
} catch (error) {
  console.error(`live ${jobSourceLabel(source)} search blocked: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
