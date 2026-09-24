import test from "node:test";
import assert from "node:assert/strict";
import { runNoToolExactSmoke } from "../src/server/agent.js";

test("Qoder no-tool faux-transport smoke returns exact OK", async () => {
  assert.equal(await runNoToolExactSmoke(), "OK");
});
