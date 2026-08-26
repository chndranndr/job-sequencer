import test from "node:test";
import assert from "node:assert/strict";
import { createRestrictedScrapeSession } from "../src/server/pi.js";

test("restricted scrape Pi session has exactly the two custom tools", async () => {
  const session = await createRestrictedScrapeSession();
  try {
    assert.deepEqual(session.getActiveToolNames().sort(), ["fetchJobDetails", "searchJobs"]);
    assert.equal(session.getActiveToolNames().some((name) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(name)), false);
  } finally {
    session.dispose();
  }
});
