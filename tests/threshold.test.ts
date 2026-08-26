import test from "node:test";
import assert from "node:assert/strict";
import { stageForScore } from "../src/shared.js";

test("scrape threshold is strict: 81 passes and 60 is discarded", () => {
  assert.equal(stageForScore(81), "Recommended");
  assert.equal(stageForScore(60), "Discarded");
});
