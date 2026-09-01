import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createEmptyProfile, type StructuredProfile } from "../src/shared.js";
import { ProfileSchema } from "../src/server/config.js";
import { buildAgentCandidateContext } from "../src/server/agents/context.js";
import { buildEvidenceBank, validateApplicationStrategy, validateCVDocument } from "../src/server/agents/evidence.js";
import { runAgentStructured } from "../src/server/agents/runtime.js";
import { evidenceRef, type ApplicationStrategy, type CVDocument, type EvidenceRef } from "../src/server/agents/types.js";

const OutputSchema = z.object({ value: z.string().min(1) }).strict();
const splitDescription = "Improved availability to 99.95% using e.g. Java. Reduced response time for customers.";
const jobPosting = "SEEKING: Staff COBOL engineer for a lunar COBOL cluster.";

function queuedExecutor(outputs: string[], prompts: string[]) {
  return async (prompt: string) => {
    prompts.push(prompt);
    const output = outputs.shift();
    if (output === undefined) throw new Error("missing structured-output fixture");
    return output;
  };
}

function sampleProfile(): StructuredProfile {
  const profile = createEmptyProfile();
  profile.identity.summary = "Backend engineer focused on Java platforms.";
  profile.workPreferences.targetRoles = ["Backend Engineer"];
  profile.experience = [{
    id: "exp-platform",
    title: "Backend Engineer",
    company: "Example",
    employmentType: "Full-time",
    location: "Remote",
    startMonth: "",
    startYear: "2024",
    endMonth: "",
    endYear: "",
    currentRole: true,
    description: splitDescription,
  }];
  profile.projects = [{
    id: "proj-api",
    name: "API Platform",
    role: "Engineer",
    description: splitDescription,
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    url: "",
  }];
  profile.skills = [{ id: "skill-java", name: "Java" }];
  profile.education = [{
    id: "edu-1",
    institution: "Example University",
    degree: "BSc",
    fieldOfStudy: "Computer Science",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    gpa: "",
  }];
  profile.certifications = [{
    id: "cert-1",
    name: "AWS Certified",
    issuer: "Amazon",
    issueDate: "",
    expiryDate: "",
    url: "",
    description: "",
  }];
  profile.languages = [{ id: "lang-en", name: "English", proficiency: "Native" }];
  profile.awards = [{
    id: "award-1",
    title: "Best Engineer",
    issuer: "Example",
    date: "2024",
    description: "Awarded for internal COBOL tooling.",
  }];
  return profile;
}

function byRef(bank: ReturnType<typeof buildEvidenceBank>, ref: string) {
  return bank.items.find(item => item.ref === ref);
}

function validDocument(profile: StructuredProfile): CVDocument {
  const bank = buildEvidenceBank(profile);
  const summaryRef = byRef(bank, "identity:summary")?.ref;
  const experienceRef = byRef(bank, "experience:exp-platform:bullet:0")?.ref;
  return {
    summary: { text: "Java platform engineer.", evidenceRefs: summaryRef ? [summaryRef] : [] },
    experiences: [{
      experienceId: "exp-platform",
      bullets: [{
        text: "Raised availability on Java services.",
        evidenceRefs: experienceRef ? [experienceRef] : [],
        transformation: "rewrite",
      }],
    }],
    skillIds: ["skill-java"],
    projects: [{ projectId: "proj-api" }],
    coverLetter: {
      subject: "Backend Engineer",
      paragraphs: [{ text: "I build Java platforms.", evidenceRefs: experienceRef ? [experienceRef] : [] }],
    },
  };
}

function validStrategy(refs: EvidenceRef[]): ApplicationStrategy {
  return {
    positioning: "Platform backend engineer.",
    targetRole: "Backend Engineer",
    primarySellingPoints: [{ angle: "Java depth", evidenceRefs: refs.slice(0, 1) }],
    requirements: [{
      requirement: "Java",
      importance: "critical",
      candidateFit: "strong",
      evidenceRefs: refs.slice(0, 1),
    }],
    narrativeGuidance: ["Lead with platform work."],
    deEmphasize: [],
    genuineGaps: ["Go"],
    rankDisagreements: [{
      rankGap: "event-driven architecture",
      strategistFit: "strong",
      note: "Async Java work covers this.",
    }],
  };
}

test("evidence bank refs match profile ids and split bullets", () => {
  const profile = sampleProfile();
  const bank = buildEvidenceBank(profile);
  const experience0 = byRef(bank, "experience:exp-platform:bullet:0");
  const experience1 = byRef(bank, "experience:exp-platform:bullet:1");
  const project0 = byRef(bank, "project:proj-api:bullet:0");
  const project1 = byRef(bank, "project:proj-api:bullet:1");
  assert.equal(experience0?.source.entityId, "exp-platform");
  assert.equal(experience0?.source.field, "description");
  assert.equal(experience0?.source.bulletIndex, 0);
  assert.match(experience0?.text ?? "", /99\.95%/);
  assert.match(experience0?.text ?? "", /e\.g\. Java/);
  assert.equal(experience1?.source.bulletIndex, 1);
  assert.match(experience1?.text ?? "", /Reduced response time/);
  assert.equal(project0?.source.entityId, "proj-api");
  assert.equal(project0?.source.bulletIndex, 0);
  assert.equal(project1?.source.bulletIndex, 1);
  assert.equal(byRef(bank, "identity:summary")?.source.entityId, "identity");
  assert.equal(byRef(bank, "skill:skill-java")?.text, "Java");
  assert.equal(byRef(bank, "education:edu-1")?.source.entityId, "edu-1");
  assert.equal(byRef(bank, "certification:cert-1")?.source.entityId, "cert-1");
  assert.equal(byRef(bank, "language:lang-en")?.source.entityId, "lang-en");
});

test("wrapped marked bullets keep their numeric claims together", () => {
  const profile = createEmptyProfile();
  profile.experience = [{
    id: "exp-wrapped",
    title: "Backend Engineer",
    company: "Example",
    employmentType: "Full-time",
    location: "Remote",
    startMonth: "",
    startYear: "2024",
    endMonth: "",
    endYear: "",
    currentRole: true,
    description: "🟤 Improved API response time by 50%,\nand reduced query time by 30%.\n🟤 Supported 5x peak volume\nwith Kafka.",
  }];
  const bank = buildEvidenceBank(profile);
  const first = byRef(bank, "experience:exp-wrapped:bullet:0");
  const second = byRef(bank, "experience:exp-wrapped:bullet:1");
  assert.match(first?.text ?? "", /50%.*30%/);
  assert.match(second?.text ?? "", /5x.*Kafka/);
  assert.equal(bank.items.filter(item => item.kind === "experience").length, 2);
});

test("awards stay off the evidence bank", () => {
  const profile = sampleProfile();
  const bank = buildEvidenceBank(profile);
  assert.equal(bank.items.some(item => item.ref.startsWith("award:")), false);
  assert.equal(bank.items.some(item => item.text.includes("Best Engineer")), false);
  assert.equal(profile.awards.length, 1);
});

test("empty summary, description, and name are skipped", () => {
  const profile = createEmptyProfile();
  profile.identity.summary = "   ";
  profile.experience = [{
    id: "exp-empty",
    title: "Engineer",
    company: "Example",
    employmentType: "",
    location: "",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    currentRole: false,
    description: "   ",
  }];
  profile.skills = [{ id: "skill-empty", name: "" }];
  profile.education = [{
    id: "edu-empty",
    institution: "",
    degree: "",
    fieldOfStudy: "",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    gpa: "",
  }];
  profile.certifications = [{
    id: "cert-empty",
    name: "  ",
    issuer: "",
    issueDate: "",
    expiryDate: "",
    url: "",
    description: "",
  }];
  profile.languages = [{ id: "lang-empty", name: "", proficiency: "Native" }];
  profile.projects = [{
    id: "proj-empty",
    name: "Empty",
    role: "",
    description: "",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    url: "",
  }];
  const bank = buildEvidenceBank(profile);
  assert.deepEqual(bank.items, []);
});

test("validateCVDocument throws on an unknown experienceId", () => {
  const profile = sampleProfile();
  const bank = buildEvidenceBank(profile);
  const document = validDocument(profile);
  assert.equal(validateCVDocument(document, profile, bank).experiences[0]?.experienceId, "exp-platform");
  document.experiences.push({ experienceId: "missing-role", bullets: [] });
  assert.throws(() => validateCVDocument(document, profile, bank), /Unknown experienceId: missing-role/);
});

test("validateCVDocument throws on an unknown EvidenceRef", () => {
  const profile = sampleProfile();
  const document = validDocument(profile);
  document.summary.evidenceRefs = [evidenceRef("skill:not-in-bank")];
  assert.throws(() => validateCVDocument(document, profile, buildEvidenceBank(profile)), /Unknown EvidenceRef: skill:not-in-bank/);
});

test("validateCVDocument canonicalizes a namespaced skill id but keeps unknown ids invalid", () => {
  const profile = sampleProfile();
  const document = validDocument(profile);
  document.skillIds = ["skill:skill-java"];
  const normalized = validateCVDocument(document, profile, buildEvidenceBank(profile));
  assert.deepEqual(normalized.skillIds, ["skill-java"]);
  assert.throws(() => validateCVDocument({ ...document, skillIds: ["skill:missing"] }, profile, buildEvidenceBank(profile)), /Unknown skillId: skill:missing/);
});

test("ProfileSchema still accepts a profile that includes awards", () => {
  const profile = sampleProfile();
  assert.doesNotThrow(() => ProfileSchema.parse(profile));
  assert.equal(ProfileSchema.parse(profile).awards[0]?.title, "Best Engineer");
});

test("job posting text never enters a profile-only evidence bank", () => {
  const bank = buildEvidenceBank(sampleProfile());
  assert.equal(bank.items.some(item => item.text.includes(jobPosting)), false);
  assert.equal(bank.items.some(item => item.text.includes("COBOL cluster")), false);
});

test("candidate context exposes bank, target roles, and writing style without a profile dump", () => {
  const profile = sampleProfile();
  const context = buildAgentCandidateContext({ profile, writingStyle: "Short sentences. No em-dashes." });
  assert.equal(context.writingStyle, "Short sentences. No em-dashes.");
  assert.deepEqual(context.preferences.targetRoles, ["Backend Engineer"]);
  assert.equal(context.preferences.workPreferences, profile.workPreferences);
  assert.ok(byRef(context.evidenceBank, "experience:exp-platform:bullet:0"));
  assert.equal("profileContext" in context, false);
  assert.equal("experience" in context, false);
  assert.equal("profile" in context, false);
});

test("runAgentStructured repairs once and ignores a higher caller maxAttempts", async () => {
  const prompts: string[] = [];
  const result = await runAgentStructured({
    prompt: "Return a value.",
    schema: OutputSchema,
    maxAttempts: 10,
    execute: queuedExecutor(["not JSON", '{"value":"ok"}', '{"value":"too many"}'], prompts),
  });
  assert.deepEqual(result, { value: "ok" });
  assert.equal(prompts.length, 2);

  let calls = 0;
  await assert.rejects(
    () => runAgentStructured({
      prompt: "Return JSON.",
      schema: OutputSchema,
      maxAttempts: 10,
      execute: async () => {
        calls += 1;
        return "still invalid";
      },
    }),
    /Structured output failed after 2 attempts/,
  );
  assert.equal(calls, 2);
});

test("validateApplicationStrategy enforces fit refs and ignores rank", () => {
  const profile = sampleProfile();
  const bank = buildEvidenceBank(profile);
  const javaRef = byRef(bank, "skill:skill-java")?.ref;
  assert.ok(javaRef);
  const strategy = validStrategy([javaRef]);
  assert.equal(validateApplicationStrategy(strategy, bank), strategy);

  assert.throws(
    () => validateApplicationStrategy({
      ...strategy,
      requirements: [{ requirement: "Java", importance: "critical", candidateFit: "strong", evidenceRefs: [] }],
    }, bank),
    /Strong or partial fit requires at least one EvidenceRef/,
  );
  assert.throws(
    () => validateApplicationStrategy({
      ...strategy,
      requirements: [{ requirement: "Go", importance: "critical", candidateFit: "gap", evidenceRefs: [javaRef] }],
    }, bank),
    /Gap fit requires empty evidenceRefs/,
  );
  assert.throws(
    () => validateApplicationStrategy({
      ...strategy,
      requirements: [{ requirement: "Java", importance: "critical", candidateFit: "strong", evidenceRefs: [evidenceRef("skill:missing")] }],
    }, bank),
    /Unknown EvidenceRef: skill:missing/,
  );
});
