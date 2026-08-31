import type { StructuredProfile } from "../../shared.js";
import { evidenceRef, type ApplicationStrategy, type CVDocument, type EvidenceBank, type EvidenceItem, type EvidenceRef } from "./types.js";

const descriptionAbbreviations = new Set(["approx", "co", "corp", "dept", "dr", "e.g", "etc", "fig", "i.e", "inc", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "ltd", "misc", "mr", "mrs", "ms", "no", "nos", "prof", "ref", "rev", "sr", "jr", "st", "vs"]);

function isDescriptionAbbreviation(value: string, index: number) {
  if (value[index] !== ".") return false;
  const match = /(?:^|[\s([{"'])([A-Za-z](?:[A-Za-z.]*)?)\.$/.exec(value.slice(0, index + 1));
  if (!match) return false;
  const token = match[1]!.toLowerCase();
  return token.length === 1 || (token.includes(".") && !token.includes("..")) || descriptionAbbreviations.has(token);
}

export function splitDescriptionIntoBullets(value: string) {
  return value.split(/\r\n?|\n/).flatMap(line => {
    const segments: string[] = [];
    let start = 0;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (!character || !".!?".includes(character) || !/^\s+[A-Z0-9]/.test(line.slice(index + 1)) || isDescriptionAbbreviation(line, index)) continue;
      const segment = line.slice(start, index + 1).trim();
      if (!segment) continue;
      segments.push(segment);
      start = index + 1;
    }
    const remainder = line.slice(start).trim();
    if (remainder) segments.push(remainder);
    return segments;
  });
}

function factualJoin(parts: readonly string[]) {
  return parts.map(part => part.trim()).filter(Boolean).join(", ");
}

function addDescriptionBullets(items: EvidenceItem[], kind: "experience" | "project", entityId: string, description: string) {
  for (const [bulletIndex, text] of splitDescriptionIntoBullets(description).map(item => item.trim()).entries()) {
    if (!text) continue;
    items.push({
      ref: evidenceRef(`${kind}:${entityId}:bullet:${bulletIndex}`),
      kind,
      text,
      source: { entityId, field: "description", bulletIndex },
    });
  }
}

export function buildEvidenceBank(profile: StructuredProfile): EvidenceBank {
  const items: EvidenceItem[] = [];
  const summary = profile.identity.summary.trim();
  if (summary) {
    items.push({
      ref: evidenceRef("identity:summary"),
      kind: "identity",
      text: summary,
      source: { entityId: "identity", field: "summary" },
    });
  }
  for (const entry of profile.experience) addDescriptionBullets(items, "experience", entry.id, entry.description);
  for (const entry of profile.education) {
    const text = factualJoin([entry.institution, entry.degree, entry.fieldOfStudy]);
    if (!text) continue;
    items.push({
      ref: evidenceRef(`education:${entry.id}`),
      kind: "education",
      text,
      source: { entityId: entry.id, field: "institution" },
    });
  }
  for (const entry of profile.skills) {
    const name = entry.name.trim();
    if (!name) continue;
    items.push({
      ref: evidenceRef(`skill:${entry.id}`),
      kind: "skill",
      text: name,
      source: { entityId: entry.id, field: "name" },
    });
  }
  for (const entry of profile.certifications) {
    const name = entry.name.trim();
    if (!name) continue;
    items.push({
      ref: evidenceRef(`certification:${entry.id}`),
      kind: "certification",
      text: factualJoin([name, entry.issuer]),
      source: { entityId: entry.id, field: "name" },
    });
  }
  for (const entry of profile.projects) addDescriptionBullets(items, "project", entry.id, entry.description);
  for (const entry of profile.languages) {
    const name = entry.name.trim();
    if (!name) continue;
    items.push({
      ref: evidenceRef(`language:${entry.id}`),
      kind: "language",
      text: factualJoin([name, entry.proficiency]),
      source: { entityId: entry.id, field: "name" },
    });
  }
  return { items };
}

function assertRefsInBank(refs: readonly EvidenceRef[], bank: EvidenceBank) {
  const known = new Set(bank.items.map(item => item.ref));
  for (const ref of refs) {
    if (!known.has(ref)) throw new Error(`Unknown EvidenceRef: ${ref}`);
  }
}

function idSet(entries: ReadonlyArray<{ id: string }>) {
  return new Set(entries.map(entry => entry.id));
}

export function validateCVDocument(document: CVDocument, profile: StructuredProfile, bank: EvidenceBank): CVDocument {
  const experienceIds = idSet(profile.experience);
  const projectIds = idSet(profile.projects);
  const skillIds = idSet(profile.skills);
  for (const experience of document.experiences) {
    if (!experienceIds.has(experience.experienceId)) throw new Error(`Unknown experienceId: ${experience.experienceId}`);
  }
  for (const project of document.projects) {
    if (!projectIds.has(project.projectId)) throw new Error(`Unknown projectId: ${project.projectId}`);
  }
  for (const skillId of document.skillIds) {
    if (!skillIds.has(skillId)) throw new Error(`Unknown skillId: ${skillId}`);
  }
  assertRefsInBank([
    ...document.summary.evidenceRefs,
    ...document.experiences.flatMap(experience => experience.bullets.flatMap(bullet => bullet.evidenceRefs)),
    ...document.projects.flatMap(project => (project.bullets ?? []).flatMap(bullet => bullet.evidenceRefs)),
    ...document.coverLetter.paragraphs.flatMap(paragraph => paragraph.evidenceRefs),
  ], bank);
  return document;
}

export function validateApplicationStrategy(strategy: ApplicationStrategy, bank: EvidenceBank): ApplicationStrategy {
  assertRefsInBank([
    ...strategy.primarySellingPoints.flatMap(point => point.evidenceRefs),
    ...strategy.requirements.flatMap(requirement => requirement.evidenceRefs),
  ], bank);
  for (const requirement of strategy.requirements) {
    if (requirement.candidateFit === "gap") {
      if (requirement.evidenceRefs.length > 0) throw new Error("Gap fit requires empty evidenceRefs.");
    } else if (requirement.evidenceRefs.length === 0) {
      throw new Error("Strong or partial fit requires at least one EvidenceRef.");
    }
  }
  return strategy;
}
