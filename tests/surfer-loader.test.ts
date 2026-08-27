import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("scrape loading keeps an optional clip with a fallback", () => {
  const loader = readFileSync(new URL("../src/surfer-loader.tsx", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../src/tracker/agent.tsx", import.meta.url), "utf8");
  const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(loader, /\/subway-surfers\.mp4/);
  assert.doesNotMatch(gitignore, /^public\/subway-surfers\.mp4$/m);
  assert.match(loader, /onError=\{\(\) => setVideoOk\(false\)\}/);
  assert.match(loader, /Video unavailable/);
  assert.match(agent, /workflow === "scrape".*SurferLoader/s);
});
