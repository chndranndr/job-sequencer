import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGeneratedPdfs, friendlyDocumentFilename } from "../src/server/documents.js";

test("friendly document filenames are concise, deterministic, and safe", () => {
  const company = "PT. HTC Global Software Services";
  const role = "Java Spring Boot Fullstack Engineer | Microservices & APIs";
  assert.equal(friendlyDocumentFilename("cv.pdf", company, role), "cv_htc_fullstack.pdf");
  assert.equal(friendlyDocumentFilename("cover-letter.pdf", company, role), "cover_letter_htc_fullstack.pdf");
  assert.equal(friendlyDocumentFilename("cv.tex", company, role), "cv_htc_fullstack.tex");
  assert.equal(friendlyDocumentFilename("cover-letter.tex", company, role), "cover_letter_htc_fullstack.tex");

  for (const name of ["cv.pdf", "cover-letter.pdf", "cv.tex", "cover-letter.tex"]) {
    const filename = friendlyDocumentFilename(name, "../../PT. /\\:??", "../odd");
    assert.match(filename, /^[a-z0-9_]+\.(pdf|tex)$/);
    assert.ok(filename.length <= 70);
    assert.doesNotMatch(filename, /\.\.|[\\/]/);
  }
});

test("PDF exports avoid collisions and remove incomplete pairs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-export-"));
  try {
    await writeFile(join(dir, "cv.pdf"), "first cv");
    const args = [dir, dir, "../Example", "../Engineer", "2026-10-02T10:00:00.000Z"] as const;
    await assert.rejects(() => exportGeneratedPdfs(...args), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(dir, "generated")), []);
    await writeFile(join(dir, "cover-letter.pdf"), "letter");
    const first = await exportGeneratedPdfs(...args);
    await writeFile(join(dir, "cv.pdf"), "second cv");
    const second = await exportGeneratedPdfs(...args);
    assert.notEqual(first, second);
    assert.equal(await readFile(join(first, "cv_example_engineer.pdf"), "utf8"), "first cv");
    assert.equal(await readFile(join(second, "cv_example_engineer.pdf"), "utf8"), "second cv");
    assert.equal((await readdir(join(dir, "generated"))).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
