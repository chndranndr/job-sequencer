import { z } from "zod";
import type { StructuredProfile } from "../../shared.js";

export type EvidenceRef = string & { readonly __brand: "EvidenceRef" };

export function evidenceRef(value: string): EvidenceRef {
  const ref = value.trim();
  if (!ref) throw new Error("EvidenceRef must be nonempty.");
  return ref as EvidenceRef;
}

export type EvidenceItem = {
  ref: EvidenceRef;
  kind: "identity" | "experience" | "skill" | "project" | "education" | "certification" | "language";
  text: string;
  source: { entityId: string; field: string; bulletIndex?: number };
};

export type EvidenceBank = { items: EvidenceItem[] };

export type AgentCandidateContext = {
  evidenceBank: EvidenceBank;
  preferences: {
    targetRoles: string[];
    workPreferences: StructuredProfile["workPreferences"];
  };
  writingStyle: string;
};

export type StrategyRequirement = {
  requirement: string;
  importance: "critical" | "important" | "nice_to_have";
  candidateFit: "strong" | "partial" | "gap";
  evidenceRefs: EvidenceRef[];
};

export type ApplicationStrategy = {
  positioning: string;
  targetRole: string;
  primarySellingPoints: Array<{ angle: string; evidenceRefs: EvidenceRef[] }>;
  requirements: StrategyRequirement[];
  narrativeGuidance: string[];
  deEmphasize: string[];
  genuineGaps: string[];
  rankDisagreements: Array<{
    rankGap: string;
    strategistFit: StrategyRequirement["candidateFit"];
    note: string;
  }>;
};

export type CVDocument = {
  summary: { text: string; evidenceRefs: EvidenceRef[] };
  experiences: Array<{
    experienceId: string;
    bullets: Array<{
      text: string;
      evidenceRefs: EvidenceRef[];
      transformation: "rewrite" | "compress" | "combine";
    }>;
  }>;
  skillIds: string[];
  projects: Array<{
    projectId: string;
    bullets?: Array<{ text: string; evidenceRefs: EvidenceRef[] }>;
  }>;
  coverLetter: {
    subject: string;
    paragraphs: Array<{ text: string; evidenceRefs: EvidenceRef[] }>;
  };
};

const EvidenceRefSchema = z.string().trim().min(1).transform(evidenceRef);
const evidenceRefs = z.array(EvidenceRefSchema);
const candidateFit = z.enum(["strong", "partial", "gap"]);

export const CVDocumentSchema = z.object({
  summary: z.object({
    text: z.string(),
    evidenceRefs,
  }).strict(),
  experiences: z.array(z.object({
    experienceId: z.string().trim().min(1),
    bullets: z.array(z.object({
      text: z.string().trim().min(1),
      evidenceRefs,
      transformation: z.enum(["rewrite", "compress", "combine"]),
    }).strict()),
  }).strict()),
  skillIds: z.array(z.string().trim().min(1)),
  projects: z.array(z.object({
    projectId: z.string().trim().min(1),
    bullets: z.array(z.object({
      text: z.string().trim().min(1),
      evidenceRefs,
    }).strict()).optional(),
  }).strict()),
  coverLetter: z.object({
    subject: z.string(),
    paragraphs: z.array(z.object({
      text: z.string().trim().min(1),
      evidenceRefs,
    }).strict()),
  }).strict(),
}).strict();

export const ApplicationStrategySchema = z.object({
  positioning: z.string().trim().min(1),
  targetRole: z.string().trim().min(1),
  primarySellingPoints: z.array(z.object({
    angle: z.string().trim().min(1),
    evidenceRefs,
  }).strict()),
  requirements: z.array(z.object({
    requirement: z.string().trim().min(1),
    importance: z.enum(["critical", "important", "nice_to_have"]),
    candidateFit,
    evidenceRefs,
  }).strict()),
  narrativeGuidance: z.array(z.string().trim().min(1)),
  deEmphasize: z.array(z.string().trim().min(1)),
  genuineGaps: z.array(z.string().trim().min(1)),
  rankDisagreements: z.array(z.object({
    rankGap: z.string().trim().min(1),
    strategistFit: candidateFit,
    note: z.string().trim().min(1),
  }).strict()),
}).strict();
