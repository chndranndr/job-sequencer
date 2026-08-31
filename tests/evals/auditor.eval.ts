import { createEmptyProfile, type StructuredProfile } from "../../src/shared.js";
import { evidenceRef, type ApplicationStrategy, type CVDocument, type FactualAudit, type FactualIssueKind } from "../../src/server/agents/types.js";

export const auditorEvalCompany = "Northwind Analytics Ltd";
export const reportingWorkflowEvidence = "Built a monthly sales reporting workflow that exported one warehouse report.";
export const globalDatabaseClaim = "Improved global database performance across the organization.";

const summaryRef = evidenceRef("identity:summary");
const reportingRef = evidenceRef("experience:exp-reporting:bullet:0");
const sqlRef = evidenceRef("skill:skill-sql");

export function auditorEvalProfile(): StructuredProfile {
  const profile = createEmptyProfile();
  profile.identity.firstName = "Ada";
  profile.identity.lastName = "Lovelace";
  profile.identity.headline = "Backend engineer";
  profile.identity.email = "ada@example.test";
  profile.identity.phone = "+1 555 0100";
  profile.identity.city = "London";
  profile.identity.country = "UK";
  profile.identity.summary = "Backend engineer who ships reporting workflows.";
  profile.workPreferences.targetRoles = ["Backend Engineer"];
  profile.experience = [{
    id: "exp-reporting",
    title: "Backend Engineer",
    company: auditorEvalCompany,
    employmentType: "Full-time",
    location: "Remote",
    startMonth: "",
    startYear: "2022",
    endMonth: "",
    endYear: "",
    currentRole: true,
    description: reportingWorkflowEvidence,
  }];
  profile.skills = [{ id: "skill-sql", name: "SQL" }];
  return profile;
}

export type AuditorEvalExpected = {
  kind?: FactualIssueKind;
  noCritical?: boolean;
};

export type AuditorEvalFixture = {
  name: "scope-inflation" | "faithful";
  posting: string;
  strategy: ApplicationStrategy;
  document: CVDocument;
  expected: AuditorEvalExpected;
};

function strategy(): ApplicationStrategy {
  return {
    positioning: "Backend engineer for reporting workflows.",
    targetRole: "Backend Engineer",
    primarySellingPoints: [{ angle: "Reporting workflows", evidenceRefs: [reportingRef] }],
    requirements: [{
      requirement: "SQL reporting",
      importance: "important",
      candidateFit: "strong",
      evidenceRefs: [reportingRef, sqlRef],
    }],
    narrativeGuidance: ["Lead with the reporting workflow."],
    deEmphasize: [],
    genuineGaps: ["Go"],
    rankDisagreements: [],
  };
}

function documentFor(bullet: string): CVDocument {
  return {
    summary: { text: "Backend engineer who ships reporting workflows.", evidenceRefs: [summaryRef] },
    experiences: [{
      experienceId: "exp-reporting",
      bullets: [{ text: bullet, evidenceRefs: [reportingRef], transformation: "rewrite" }],
    }],
    skillIds: ["skill-sql"],
    projects: [],
    coverLetter: {
      subject: "Backend Engineer",
      paragraphs: [{ text: "I built a monthly sales reporting workflow.", evidenceRefs: [reportingRef] }],
    },
  };
}

export function scopeInflationAuditorFixture(): AuditorEvalFixture {
  return {
    name: "scope-inflation",
    posting: "Database platform engineer to improve global database performance.",
    strategy: strategy(),
    document: documentFor(globalDatabaseClaim),
    expected: { kind: "scope_inflation" },
  };
}

export function faithfulAuditorFixture(): AuditorEvalFixture {
  return {
    name: "faithful",
    posting: "Database platform engineer to improve global database performance.",
    strategy: strategy(),
    document: documentFor(reportingWorkflowEvidence),
    expected: { noCritical: true },
  };
}

export function scoreAuditor(audit: FactualAudit, expected: AuditorEvalExpected) {
  const failures: string[] = [];
  if (expected.kind && !audit.issues.some(issue => issue.kind === expected.kind)) {
    failures.push(`expected kind ${expected.kind}`);
  }
  if (expected.noCritical && audit.issues.some(issue => issue.severity === "critical")) {
    failures.push("unexpected critical issue");
  }
  return { ok: failures.length === 0, failures };
}
