import test from "node:test";
import assert from "node:assert/strict";
import { createSmokeDatabase } from "../src/server/db.js";

test("node:sqlite can create, write, and read a row", () => {
  const db = createSmokeDatabase();
  db.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
  const row = db.prepare("SELECT value FROM smoke").get() as { value: string };
  assert.equal(row.value, "ok");
  db.close();
});
