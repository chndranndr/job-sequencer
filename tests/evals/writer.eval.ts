import { createEmptyProfile, defaultGenerationDirection, type GenerationDirection, type StructuredProfile } from "../../src/shared.js";
import { evidenceRef, type ApplicationStrategy, type CVDocument } from "../../src/server/agents/types.js";

export const writerEvalCompany = "Aetherwave Robotics Ltd";

export function writerEvalProfile(): StructuredProfile {
  const profile = createEmptyProfile();
  profile.identity.firstName = "Ada";
  profile.identity.lastName = "Lovelace";
  profile.identity.headline = "Backend engineer";
  profile.identity.email = "ada@example.test";
  profile.identity.phone = "+1 555 0100";
  profile.identity.city = "London";
  profile.identity.country = "UK";
  profile.identity.summary = "Java engineer for platforms and payments.";
  profile.workPreferences.targetRoles = ["Backend Engineer"];
  profile.experience = [{
    id: "exp-aetherwave",
    title: "Backend Engineer",
    company: writerEvalCompany,
    employmentType: "Full-time",
    location: "Remote",
    startMonth: "",
    startYear: "2022",
    endMonth: "",
    endYear: "",
    currentRole: true,
    description: "Produced Kafka topics for payment workflows. Cut gold-ledger query time by 30%.",
  }];
  profile.education = [{
    id: "edu-1",
    institution: "Canonical University",
    degree: "BSc",
    fieldOfStudy: "Computer Science",
    startMonth: "",
    startYear: "2016",
    endMonth: "",
    endYear: "2020",
    gpa: "",
  }];
  profile.skills = [
    { id: "skill-java", name: "Java" },
    { id: "skill-kafka", name: "Kafka" },
  ];
  profile.projects = [{
    id: "proj-ledger",
    name: "Ledger API",
    role: "Engineer",
    description: "Built Java payment APIs.",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    url: "",
  }];
  return profile;
}

export type WriterEvalFixture = {
  name: "platform" | "payments";
  posting: string;
  direction: GenerationDirection;
  strategy: ApplicationStrategy;
  document: CVDocument;
};

const kafkaRef = evidenceRef("skill:skill-kafka");
const javaRef = evidenceRef("skill:skill-java");
const bullet0 = evidenceRef("experience:exp-aetherwave:bullet:0");
const bullet1 = evidenceRef("experience:exp-aetherwave:bullet:1");
const summaryRef = evidenceRef("identity:summary");

function baseStrategy(input: {
  positioning: string;
  angle: string;
  guidance: string;
  refs: ApplicationStrategy["primarySellingPoints"][number]["evidenceRefs"];
}): ApplicationStrategy {
  return {
    positioning: input.positioning,
    targetRole: "Backend Engineer",
    primarySellingPoints: [{ angle: input.angle, evidenceRefs: input.refs }],
    requirements: [{
      requirement: input.angle,
      importance: "critical",
      candidateFit: "strong",
      evidenceRefs: input.refs,
    }],
    narrativeGuidance: [input.guidance],
    deEmphasize: [],
    genuineGaps: ["Go"],
    rankDisagreements: [],
  };
}

export function platformWriterFixture(): WriterEvalFixture {
  return {
    name: "platform",
    posting: "Platform engineer for event-driven Kafka services and async payment workflows.",
    direction: defaultGenerationDirection,
    strategy: baseStrategy({
      positioning: "Platform engineer for event-driven Java services.",
      angle: "Kafka",
      guidance: "Lead with Kafka and async payments.",
      refs: [kafkaRef, bullet0],
    }),
    document: {
      summary: { text: "Platform engineer who ships event-driven Java services on Kafka.", evidenceRefs: [summaryRef, kafkaRef] },
      experiences: [{
        experienceId: "exp-aetherwave",
        bullets: [
          { text: "Produced Kafka topics that captured payment events.", evidenceRefs: [bullet0], transformation: "rewrite" },
          { text: "Kept gold-ledger queries fast enough for daily capture.", evidenceRefs: [bullet1], transformation: "compress" },
        ],
      }],
      skillIds: ["skill-kafka", "skill-java"],
      projects: [{ projectId: "proj-ledger" }],
      coverLetter: {
        subject: "Platform Engineer",
        paragraphs: [{ text: "I build Kafka payment workflows in Java.", evidenceRefs: [bullet0, kafkaRef] }],
      },
    },
  };
}

export function paymentsWriterFixture(): WriterEvalFixture {
  return {
    name: "payments",
    posting: "Payments engineer for gold-ledger Java services and query latency work.",
    direction: defaultGenerationDirection,
    strategy: baseStrategy({
      positioning: "Payments engineer for gold-ledger Java services.",
      angle: "payments",
      guidance: "Lead with gold-ledger query work.",
      refs: [javaRef, bullet1],
    }),
    document: {
      summary: { text: "Payments engineer focused on gold-ledger Java services.", evidenceRefs: [summaryRef, javaRef] },
      experiences: [{
        experienceId: "exp-aetherwave",
        bullets: [
          { text: "Cut gold-ledger query time by 30% on daily capture.", evidenceRefs: [bullet1], transformation: "rewrite" },
          { text: "Used Kafka only as the capture bus behind that ledger.", evidenceRefs: [bullet0], transformation: "compress" },
        ],
      }],
      skillIds: ["skill-java"],
      projects: [{ projectId: "proj-ledger" }],
      coverLetter: {
        subject: "Payments Engineer",
        paragraphs: [{ text: "I cut gold-ledger query time in Java payment services.", evidenceRefs: [bullet1] }],
      },
    },
  };
}

export function scoreWriterPair(left: CVDocument, right: CVDocument) {
  const failures: string[] = [];
  if (left.summary.text === right.summary.text) failures.push("summaries should differ");
  const leftLead = left.experiences[0]?.bullets[0]?.text ?? "";
  const rightLead = right.experiences[0]?.bullets[0]?.text ?? "";
  if (!leftLead || !rightLead) failures.push("each document needs a lead experience bullet");
  else if (leftLead === rightLead) failures.push("lead bullets should differ");
  return { ok: failures.length === 0, failures };
}
