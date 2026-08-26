import { runNoToolExactSmoke } from "../src/server/pi.js";
import { createSmokeDatabase } from "../src/server/db.js";

const db = createSmokeDatabase();
db.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
const row = db.prepare("SELECT value FROM smoke").get() as { value: string };
db.close();
console.log(`sqlite=${row.value}`);
console.log(`pi=${await runNoToolExactSmoke()}`);
