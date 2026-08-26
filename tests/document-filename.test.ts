import test from "node:test";
import assert from "node:assert/strict";
import { friendlyDocumentFilename } from "../src/server/documents.js";

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

