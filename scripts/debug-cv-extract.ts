import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { extractProfileText } from "../src/server/profile-import.js";

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: npm run debug:cv -- <path-to-cv>");

  const path = resolve(input);
  const { format, text } = await extractProfileText({
    filename: basename(path),
    mimetype: "application/octet-stream",
    buffer: await readFile(path),
  });

  process.stderr.write(`${JSON.stringify({ input: path, format, textLength: text.length })}\n`);
  process.stdout.write(`${text}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
