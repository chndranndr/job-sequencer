import { readFileSync, writeFileSync } from "node:fs";
import { extractProfileText } from "../src/server/profile-import.js";

const pdfPath = process.argv[2] ?? "H:/work/ai-job-search/cv/pdf/cv_chandra_complete.pdf";
const buf = readFileSync(pdfPath);
const { text, format } = await extractProfileText({ filename: "cv.pdf", mimetype: "application/pdf", buffer: buf });
const out = "H:/work/greenfield/.audit/cv-extract.txt";
writeFileSync(out, text, "utf8");
console.log(JSON.stringify({ format, length: text.length, out }, null, 2));
