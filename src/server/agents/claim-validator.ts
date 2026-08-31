import type { StructuredProfile } from "../../shared.js";
import { validateCVDocument } from "./evidence.js";
import type { CVDocument, EvidenceBank, EvidenceItem, EvidenceRef } from "./types.js";

type NumericClaim = {
  normalized: string;
  display: string;
};

function itemsByRef(bank: EvidenceBank) {
  return new Map(bank.items.map(item => [item.ref, item]));
}

function citedItems(input: {
  refs: readonly EvidenceRef[];
  byRef: Map<EvidenceRef, EvidenceItem>;
}) {
  const items: EvidenceItem[] = [];
  for (const ref of input.refs) {
    const item = input.byRef.get(ref);
    if (item) items.push(item);
  }
  return items;
}

function claimFields(document: CVDocument) {
  return [
    document.summary,
    ...document.experiences.flatMap(experience => experience.bullets),
    ...document.projects.flatMap(project => project.bullets ?? []),
    ...document.coverLetter.paragraphs,
  ];
}

function extractNumericClaims(text: string) {
  const claims: NumericClaim[] = [];
  const pattern = /(?<![A-Za-z0-9.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s*(%)|\s*(percent)\b|([xX])\b|(\s+times)\b|([A-Za-z]+))?/gi;
  for (const match of text.matchAll(pattern)) {
    const integer = match[1];
    if (!integer) continue;
    const fraction = match[2] ?? "";
    const magnitude = `${integer.replace(/,/g, "")}${fraction}`;
    const percent = match[3] !== undefined || match[4] !== undefined;
    const multiplier = match[5] !== undefined;
    const times = match[6] !== undefined;
    const unit = match[7];
    if (!percent && !multiplier && !times && !unit) {
      const year = Number(magnitude);
      if (fraction === "" && Number.isInteger(year) && year >= 1900 && year <= 2099) continue;
    }
    const normalized = percent
      ? `${magnitude}%`
      : multiplier || times
        ? `${magnitude}x`
        : unit
          ? `${magnitude}${unit.toLowerCase()}`
          : magnitude;
    claims.push({ normalized, display: match[0].trim() });
  }
  return claims;
}

function mentionsCompany(input: { text: string; company: string }) {
  const company = input.company.trim();
  if (company.length < 2) return false;
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = /^\w/.test(company) ? "\\b" : "";
  const end = /\w$/.test(company) ? "\\b" : "";
  return new RegExp(`${start}${escaped}${end}`, "i").test(input.text);
}

function assertSupportedNumbers(input: {
  document: CVDocument;
  byRef: Map<EvidenceRef, EvidenceItem>;
}) {
  for (const field of claimFields(input.document)) {
    const evidenceText = citedItems({ refs: field.evidenceRefs, byRef: input.byRef }).map(item => item.text).join(" ");
    const allowed = new Set(extractNumericClaims(evidenceText).map(item => item.normalized));
    for (const token of extractNumericClaims(field.text)) {
      if (!allowed.has(token.normalized)) throw new Error(`Unsupported number: ${token.display}`);
    }
  }
}

function assertExperienceLocality(input: {
  document: CVDocument;
  byRef: Map<EvidenceRef, EvidenceItem>;
}) {
  for (const experience of input.document.experiences) {
    for (const bullet of experience.bullets) {
      for (const item of citedItems({ refs: bullet.evidenceRefs, byRef: input.byRef })) {
        if (item.kind !== "experience") continue;
        if (item.source.entityId === experience.experienceId) continue;
        throw new Error(`Experience locality: cited ${item.source.entityId} on ${experience.experienceId}`);
      }
    }
  }
}

function assertProjectLocality(input: {
  document: CVDocument;
  byRef: Map<EvidenceRef, EvidenceItem>;
}) {
  for (const project of input.document.projects) {
    for (const bullet of project.bullets ?? []) {
      for (const item of citedItems({ refs: bullet.evidenceRefs, byRef: input.byRef })) {
        if (item.kind !== "project") continue;
        if (item.source.entityId === project.projectId) continue;
        throw new Error(`Project locality: cited ${item.source.entityId} on ${project.projectId}`);
      }
    }
  }
}

function assertUnknownEntities(input: {
  document: CVDocument;
  profile: StructuredProfile;
}) {
  const companies = input.profile.experience.map(entry => entry.company.trim()).filter(name => name.length >= 2);
  for (const experience of input.document.experiences) {
    const local = input.profile.experience.find(entry => entry.id === experience.experienceId);
    const localName = local?.company.trim().toLowerCase() ?? "";
    for (const bullet of experience.bullets) {
      for (const company of companies) {
        if (company.toLowerCase() === localName) continue;
        if (mentionsCompany({ text: bullet.text, company })) {
          throw new Error(`Experience bullet names another employer: ${company}`);
        }
      }
    }
  }
}

export function validateClaims(input: {
  document: CVDocument;
  profile: StructuredProfile;
  bank: EvidenceBank;
}): CVDocument {
  const document = validateCVDocument(input.document, input.profile, input.bank);
  const byRef = itemsByRef(input.bank);
  assertExperienceLocality({ document, byRef });
  assertProjectLocality({ document, byRef });
  assertUnknownEntities({ document, profile: input.profile });
  assertSupportedNumbers({ document, byRef });
  return document;
}
