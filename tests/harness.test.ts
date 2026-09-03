import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findArchitectureViolations, findBrokenMarkdownLinks } from "../scripts/harness.js";

test("harness checks detect broken docs and crossed application boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "job-sequencer-harness-"));
  try {
    await mkdir(join(root, "src", "server"), { recursive: true });
    await mkdir(join(root, "src", "tracker"), { recursive: true });
    const guide = join(root, "AGENTS.md");
    await writeFile(guide, "[missing](docs/missing.md)\n");
    await writeFile(join(root, "src", "server", "bad.ts"), 'import "../tracker/view.js";\n');

    assert.deepEqual(await findBrokenMarkdownLinks(root, [guide]), ["AGENTS.md -> docs/missing.md"]);
    assert.deepEqual(await findArchitectureViolations(root), ["src/server/bad.ts: server -> tracker"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
