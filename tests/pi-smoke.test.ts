import test from "node:test";
import assert from "node:assert/strict";
import { runNoToolExactSmoke } from "../src/server/pi.js";

test("Pi no-tool faux-provider smoke returns exact OK", async () => {
  assert.equal(await runNoToolExactSmoke(), "OK");
});
