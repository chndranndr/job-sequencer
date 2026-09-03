import type { CVDocument } from "../agents/types.js";

function normalizeProse(value: string) {
  return value.replace(/\s*[\u2011\u2013\u2014]\s*/g, ", ").replace(/--+/g, ", ").replace(/[ \t]{2,}/g, " ").trim();
}

const latexEscapes: Record<string, string> = { "\\": "\\textbackslash{}", "#": "\\#", "$": "\\$", "%": "\\%", "&": "\\&", "_": "\\_", "{": "\\{", "}": "\\}", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}" };
function latex(value: string) { return normalizeProse(value).replace(/[\\#$%&_{}^~]/g, character => latexEscapes[character] ?? character); }

function hasEquivalentClosing(paragraphs: readonly string[]) {
  return paragraphs.some(paragraph => {
    const text = normalizeProse(paragraph);
    return /\bwelcom\w*\b/i.test(text) && /\b(?:opportunit\w*|contribut\w*)\b/i.test(text);
  });
}

export function coverLetterClosing(paragraphs: readonly string[], role: string, company: string) {
  return hasEquivalentClosing(paragraphs) ? "" : latex(`I would welcome the opportunity to discuss how I can contribute to ${role} at ${company}.`);
}

export function renderCoverLetter(document: CVDocument, role: string, company: string) {
  const paragraphs = document.coverLetter.paragraphs.map(paragraph => paragraph.text);
  return {
    subject: document.coverLetter.subject || `Application for ${role} at ${company}`,
    paragraphs,
    closing: coverLetterClosing(paragraphs, role, company),
  };
}
