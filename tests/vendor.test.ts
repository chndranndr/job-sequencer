import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "vendor", "ai-job-search-skills");
const expected = [
  "freehire-search",
  "japan-boards-search",
  "job-application-assistant",
  "job-scraper",
  "jobbank-search",
  "jobdanmark-search",
  "jobindex-search",
  "jobnet-search",
  "linkedin-search",
  "upskill",
];

test("all ten reusable skill directories and FreeHire CLI exist", () => {
  for (const name of expected) assert.equal(existsSync(join(root, name)), true, name);
  assert.equal(existsSync(join(root, "freehire-search", "cli", "src", "cli.ts")), true);
  assert.equal(existsSync(join(root, "freehire-search", "cli", "tests")), true);
});
