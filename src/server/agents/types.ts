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
    technologiesUsed?: Array<{
      name: string;
      evidenceRefs: EvidenceRef[];
    }>;
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
const nonEmptyEvidenceRefs = evidenceRefs.min(1);
const candidateFit = z.enum(["strong", "partial", "gap"]);

export const CVDocumentSchema = z.object({
  summary: z.object({
    text: z.string(),
    evidenceRefs,
  }).strict(),
  experiences: z.array(z.object({
    experienceId: z.string().trim().min(1),
    technologiesUsed: z.array(z.object({
      name: z.string().trim().min(1),
      evidenceRefs: nonEmptyEvidenceRefs,
    }).strict()).min(1).optional(),
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

export type FactualIssueKind = "semantic_overclaim" | "scope_inflation" | "role_inflation";
export type FactualIssueSeverity = "critical" | "high" | "medium" | "low";

export type FactualIssue = {
  kind: FactualIssueKind;
  severity: FactualIssueSeverity;
  claim: string;
  evidenceRefs: EvidenceRef[];
  note: string;
};

export type FactualAudit = {
  issues: FactualIssue[];
};

export const FactualAuditSchema = z.object({
  issues: z.array(z.object({
    kind: z.enum(["semantic_overclaim", "scope_inflation", "role_inflation"]),
    severity: z.enum(["critical", "high", "medium", "low"]),
    claim: z.string().trim().min(1),
    evidenceRefs,
    note: z.string().trim().min(1),
  }).strict()),
}).strict();

export const CRITIC_SCORE_THRESHOLD = 7;

export type CriticIssueSeverity = "high" | "medium" | "low";
export type CriticDimension = "relevance" | "specificity" | "clarity" | "order" | "letter";

export type CriticIssue = {
  severity: CriticIssueSeverity;
  dimension: CriticDimension;
  note: string;
};

export type Critique = {
  score: number;
  issues: CriticIssue[];
  summary: string;
};

export const CritiqueSchema = z.object({
  score: z.number().int().min(1).max(10),
  issues: z.array(z.object({
    severity: z.enum(["high", "medium", "low"]),
    dimension: z.enum(["relevance", "specificity", "clarity", "order", "letter"]),
    note: z.string().trim().min(1),
  }).strict()),
  summary: z.string().trim().min(1),
}).strict();

export type AtsIssueKind = "missing_but_supported" | "genuine_gap";
export type AtsIssue = { requirement: string; kind: AtsIssueKind; evidenceRefs: EvidenceRef[]; note: string };
export type AtsReview = { issues: AtsIssue[]; summary: string };

export const AtsReviewSchema = z.object({
  issues: z.array(z.object({
    requirement: z.string().trim().min(1),
    kind: z.enum(["missing_but_supported", "genuine_gap"]),
    evidenceRefs,
    note: z.string().trim().min(1),
  }).strict()),
  summary: z.string().trim().min(1),
}).strict();
