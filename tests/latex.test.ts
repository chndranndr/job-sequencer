import test from "node:test";
import assert from "node:assert/strict";
import { latexSmokeCommands } from "../src/server/documents.js";

test("LaTeX smoke commands use fixed executables and argument arrays", () => {
  assert.deepEqual(latexSmokeCommands("draft.tex"), [
    ["lualatex", ["-interaction=nonstopmode", "draft.tex"]],
    ["xelatex", ["-interaction=nonstopmode", "draft.tex"]],
    ["pdfinfo", ["draft.pdf"]],
    ["pdftotext", ["draft.pdf", "-"]],
  ]);
});
