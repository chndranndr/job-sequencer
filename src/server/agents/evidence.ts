import type { StructuredProfile } from "../../shared.js";
import { evidenceRef, type ApplicationStrategy, type CVDocument, type EvidenceBank, type EvidenceItem, type EvidenceRef } from "./types.js";

const descriptionAbbreviations = new Set(["approx", "co", "corp", "dept", "dr", "e.g", "etc", "fig", "i.e", "inc", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "ltd", "misc", "mr", "mrs", "ms", "no", "nos", "prof", "ref", "rev", "sr", "jr", "st", "vs"]);
const bulletLinePattern = /^\s*(?:[🟤•●▪◦◉⚫]|[-*])(?:\s+|$)/u;

function isDescriptionAbbreviation(value: string, index: number) {
  if (value[index] !== ".") return false;
  const match = /(?:^|[\s([{"'])([A-Za-z](?:[A-Za-z.]*)?)\.$/.exec(value.slice(0, index + 1));
  if (!match) return false;
  const token = match[1]!.toLowerCase();
  return token.length === 1 || (token.includes(".") && !token.includes("..")) || descriptionAbbreviations.has(token);
}

export function splitDescriptionIntoBullets(value: string) {
  const lines = value.split(/\r\n?|\n/);
  const wrapped = lines.some(line => bulletLinePattern.test(line))
    ? lines.reduce<string[]>((result, line) => {
      const trimmed = line.trim();
      if (!trimmed) return result;
      if (result.length && !bulletLinePattern.test(line)) result[result.length - 1] = `${result[result.length - 1]} ${trimmed}`;
      else result.push(trimmed);
      return result;
    }, [])
    : lines;
  return wrapped.flatMap(line => {
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

export function evidenceRefCatalog(bank: EvidenceBank) {
  return bank.items.map(item => ({ ref: item.ref, kind: item.kind, text: item.text }));
}

function normalizedEvidenceLabel(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeEvidenceRefs(refs: readonly EvidenceRef[], bank: EvidenceBank): EvidenceRef[] {
  const normalized = refs.map(ref => {
    if (bank.items.some(item => item.ref === ref)) return ref;
    if (!/^skill:/i.test(ref)) return ref;
    const label = normalizedEvidenceLabel(ref.slice("skill:".length));
    const matches = bank.items.filter(item => item.kind === "skill" && normalizedEvidenceLabel(item.text) === label);
    return matches.length === 1 ? matches[0]!.ref : ref;
  });
  return normalized.every((ref, index) => ref === refs[index]) ? refs as EvidenceRef[] : normalized;
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

function canonicalSkillIds(skillIds: string[], known: ReadonlySet<string>) {
  const normalized = skillIds.map(skillId => {
    if (known.has(skillId)) return skillId;
    const rawId = skillId.startsWith("skill:") ? skillId.slice("skill:".length) : "";
    return rawId && known.has(rawId) ? rawId : skillId;
  });
  return normalized.every((skillId, index) => skillId === skillIds[index]) ? skillIds : normalized;
}

function assertNonEmptyClaimRefs(document: CVDocument) {
  const assertPresent = (label: string, refs: readonly EvidenceRef[]) => {
    if (!refs.length) throw new Error(`${label} requires at least one EvidenceRef.`);
  };
  assertPresent("Summary", document.summary.evidenceRefs);
  for (const experience of document.experiences) {
    for (const [index, technology] of (experience.technologiesUsed ?? []).entries()) assertPresent(`Experience ${experience.experienceId} technology ${index}`, technology.evidenceRefs);
    for (const [index, bullet] of experience.bullets.entries()) assertPresent(`Experience ${experience.experienceId} bullet ${index}`, bullet.evidenceRefs);
  }
  for (const project of document.projects) for (const [index, bullet] of (project.bullets ?? []).entries()) assertPresent(`Project ${project.projectId} bullet ${index}`, bullet.evidenceRefs);
}

export function validateCVDocument(document: CVDocument, profile: StructuredProfile, bank: EvidenceBank): CVDocument {
  const experienceIds = idSet(profile.experience);
  const projectIds = idSet(profile.projects);
  const skillIds = idSet(profile.skills);
  const normalizedSkillIds = canonicalSkillIds(document.skillIds, skillIds);
  let changed = normalizedSkillIds !== document.skillIds;
  const summaryRefs = normalizeEvidenceRefs(document.summary.evidenceRefs, bank);
  changed ||= summaryRefs !== document.summary.evidenceRefs;
  const experiences = document.experiences.map(experience => {
    let experienceChanged = false;
    const technologiesUsed = experience.technologiesUsed?.map(technology => {
      const evidenceRefs = normalizeEvidenceRefs(technology.evidenceRefs, bank);
      experienceChanged ||= evidenceRefs !== technology.evidenceRefs;
      return evidenceRefs === technology.evidenceRefs ? technology : { ...technology, evidenceRefs };
    });
    const bullets = experience.bullets.map(bullet => {
      const evidenceRefs = normalizeEvidenceRefs(bullet.evidenceRefs, bank);
      experienceChanged ||= evidenceRefs !== bullet.evidenceRefs;
      return evidenceRefs === bullet.evidenceRefs ? bullet : { ...bullet, evidenceRefs };
    });
    changed ||= experienceChanged;
    return experienceChanged ? { ...experience, technologiesUsed, bullets } : experience;
  });
  const projects = document.projects.map(project => {
    let projectChanged = false;
    const bullets = project.bullets?.map(bullet => {
      const evidenceRefs = normalizeEvidenceRefs(bullet.evidenceRefs, bank);
      projectChanged ||= evidenceRefs !== bullet.evidenceRefs;
      return evidenceRefs === bullet.evidenceRefs ? bullet : { ...bullet, evidenceRefs };
    });
    changed ||= projectChanged;
    return projectChanged ? { ...project, bullets } : project;
  });
  const paragraphs = document.coverLetter.paragraphs.map(paragraph => {
    const evidenceRefs = normalizeEvidenceRefs(paragraph.evidenceRefs, bank);
    changed ||= evidenceRefs !== paragraph.evidenceRefs;
    return evidenceRefs === paragraph.evidenceRefs ? paragraph : { ...paragraph, evidenceRefs };
  });
  const normalizedDocument = changed
    ? {
      ...document,
      summary: summaryRefs === document.summary.evidenceRefs ? document.summary : { ...document.summary, evidenceRefs: summaryRefs },
      experiences,
      skillIds: normalizedSkillIds,
      projects,
      coverLetter: paragraphs.every((paragraph, index) => paragraph === document.coverLetter.paragraphs[index])
        ? document.coverLetter
        : { ...document.coverLetter, paragraphs },
    }
    : document;
  for (const experience of normalizedDocument.experiences) {
    if (!experienceIds.has(experience.experienceId)) throw new Error(`Unknown experienceId: ${experience.experienceId}`);
  }
  for (const project of normalizedDocument.projects) {
    if (!projectIds.has(project.projectId)) throw new Error(`Unknown projectId: ${project.projectId}`);
  }
  for (const skillId of normalizedDocument.skillIds) {
    if (!skillIds.has(skillId)) throw new Error(`Unknown skillId: ${skillId}`);
  }
  assertNonEmptyClaimRefs(normalizedDocument);
  assertRefsInBank([
    ...normalizedDocument.summary.evidenceRefs,
    ...normalizedDocument.experiences.flatMap(experience => [
      ...(experience.technologiesUsed ?? []).flatMap(technology => technology.evidenceRefs),
      ...experience.bullets.flatMap(bullet => bullet.evidenceRefs),
    ]),
    ...normalizedDocument.projects.flatMap(project => (project.bullets ?? []).flatMap(bullet => bullet.evidenceRefs)),
    ...normalizedDocument.coverLetter.paragraphs.flatMap(paragraph => paragraph.evidenceRefs),
  ], bank);
  return normalizedDocument;
}

export function validateApplicationStrategy(strategy: ApplicationStrategy, bank: EvidenceBank): ApplicationStrategy {
  const primarySellingPoints = strategy.primarySellingPoints.map(point => ({ ...point, evidenceRefs: normalizeEvidenceRefs(point.evidenceRefs, bank) }));
  const requirements = strategy.requirements.map(requirement => ({ ...requirement, evidenceRefs: normalizeEvidenceRefs(requirement.evidenceRefs, bank) }));
  const normalizedStrategy = primarySellingPoints.every((point, index) => point.evidenceRefs === strategy.primarySellingPoints[index]?.evidenceRefs)
    && requirements.every((requirement, index) => requirement.evidenceRefs === strategy.requirements[index]?.evidenceRefs)
    ? strategy
    : { ...strategy, primarySellingPoints, requirements };
  assertRefsInBank([
    ...normalizedStrategy.primarySellingPoints.flatMap(point => point.evidenceRefs),
    ...normalizedStrategy.requirements.flatMap(requirement => requirement.evidenceRefs),
  ], bank);
  for (const requirement of normalizedStrategy.requirements) {
    if (requirement.candidateFit === "gap") {
      if (requirement.evidenceRefs.length > 0) throw new Error("Gap fit requires empty evidenceRefs.");
    } else if (requirement.evidenceRefs.length === 0) {
      throw new Error("Strong or partial fit requires at least one EvidenceRef.");
    }
  }
  return normalizedStrategy;
}
