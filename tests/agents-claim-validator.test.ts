import test from "node:test";
import assert from "node:assert/strict";
import { createEmptyProfile, type StructuredProfile } from "../src/shared.js";
import { buildAgentCandidateContext } from "../src/server/agents/context.js";
import { validateClaims } from "../src/server/agents/claim-validator.js";
import { buildEvidenceBank } from "../src/server/agents/evidence.js";
import { runWriter } from "../src/server/agents/writer.js";
import { StructuredOutputError } from "../src/server/structured.js";
import type { CVDocument, EvidenceBank, EvidenceItem, EvidenceRef } from "../src/server/agents/types.js";
import {
  paymentsWriterFixture,
  platformWriterFixture,
  writerEvalProfile,
} from "./evals/writer.eval.js";

function queuedExecutor(outputs: string[], prompts: string[]) {
  return async (prompt: string) => {
    prompts.push(prompt);
    const output = outputs.shift();
    if (output === undefined) throw new Error("missing structured-output fixture");
    return output;
  };
}

function twoEmployerProfile(): StructuredProfile {
  const profile = writerEvalProfile();
  profile.experience = [
    {
      id: "exp-infosys",
      title: "Backend Engineer",
      company: "Infosys",
      employmentType: "Full-time",
      location: "Remote",
      startMonth: "",
      startYear: "2020",
      endMonth: "",
      endYear: "2022",
      currentRole: false,
      description: "Cut gold-ledger query time by 30%. Built Java services.",
    },
    {
      id: "exp-tcs",
      title: "Software Engineer",
      company: "TCS",
      employmentType: "Full-time",
      location: "Remote",
      startMonth: "",
      startYear: "2018",
      endMonth: "",
      endYear: "2020",
      currentRole: false,
      description: "Shipped payment APIs.",
    },
  ];
  return profile;
}

function itemOf(bank: EvidenceBank, input: {
  kind: EvidenceItem["kind"];
  entityId: string;
  bulletIndex?: number;
}) {
  return bank.items.find(item =>
    item.kind === input.kind
    && item.source.entityId === input.entityId
    && (input.bulletIndex === undefined || item.source.bulletIndex === input.bulletIndex)
  );
}

function requireRef(item: EvidenceItem | undefined, label: string): EvidenceRef {
  const ref = item?.ref;
  if (!ref) throw new Error(`missing ${label} evidence`);
  return ref;
}

function twoEmployerDocument(profile: StructuredProfile, bank: EvidenceBank): CVDocument {
  const identity = requireRef(itemOf(bank, { kind: "identity", entityId: "identity" }), "identity");
  const infosys0 = requireRef(itemOf(bank, { kind: "experience", entityId: "exp-infosys", bulletIndex: 0 }), "infosys 30%");
  const infosys1 = requireRef(itemOf(bank, { kind: "experience", entityId: "exp-infosys", bulletIndex: 1 }), "infosys java");
  const tcs0 = requireRef(itemOf(bank, { kind: "experience", entityId: "exp-tcs", bulletIndex: 0 }), "tcs");
  return {
    summary: { text: "Java engineer for platforms and payments.", evidenceRefs: [identity] },
    experiences: [
      {
        experienceId: "exp-infosys",
        technologiesUsed: [{ name: "Java", evidenceRefs: [infosys1] }],
        bullets: [
          { text: "Cut gold-ledger query time by 30%.", evidenceRefs: [infosys0], transformation: "rewrite" },
          { text: "Built Java services.", evidenceRefs: [infosys1], transformation: "compress" },
        ],
      },
      {
        experienceId: "exp-tcs",
        bullets: [
          { text: "Shipped payment APIs.", evidenceRefs: [tcs0], transformation: "rewrite" },
        ],
      },
    ],
    skillIds: profile.skills.map(entry => entry.id),
    projects: profile.projects.map(entry => ({ projectId: entry.id })),
    coverLetter: {
      subject: "Backend Engineer",
      paragraphs: [{ text: "I build Java services.", evidenceRefs: [identity] }],
    },
  };
}

function inflatedPaymentsDocument(): CVDocument {
  const document = paymentsWriterFixture().document;
  const experience = document.experiences[0];
  const lead = experience?.bullets[0];
  if (!experience || !lead) throw new Error("payments fixture missing lead bullet");
  return {
    ...document,
    experiences: [{
      ...experience,
      bullets: [
        { ...lead, text: lead.text.replace("30%", "50%") },
        ...experience.bullets.slice(1),
      ],
    }],
  };
}

test("writer eval fixtures pass validateClaims", () => {
  const profile = writerEvalProfile();
  const bank = buildEvidenceBank(profile);
  const platform = platformWriterFixture().document;
  const payments = paymentsWriterFixture().document;
  assert.equal(validateClaims({ document: platform, profile, bank }), platform);
  assert.equal(validateClaims({ document: payments, profile, bank }), payments);
});

test("faithful 30% rewrite citing its evidence does not throw", () => {
  const profile = writerEvalProfile();
  const bank = buildEvidenceBank(profile);
  const document = paymentsWriterFixture().document;
  assert.equal(validateClaims({ document, profile, bank }), document);
});

test("generated 50% citing evidence that only has 30% throws", () => {
  const profile = writerEvalProfile();
  const bank = buildEvidenceBank(profile);
  assert.throws(
    () => validateClaims({ document: inflatedPaymentsDocument(), profile, bank }),
    error => error instanceof Error && error.message === "Unsupported number: 50%",
  );
});

test("Infosys experience bullet citing the other employer throws", () => {
  const profile = twoEmployerProfile();
  const bank = buildEvidenceBank(profile);
  const document = twoEmployerDocument(profile, bank);
  const tcs0 = requireRef(itemOf(bank, { kind: "experience", entityId: "exp-tcs", bulletIndex: 0 }), "tcs");
  const infosys = document.experiences[0];
  const lead = infosys?.bullets[0];
  if (!infosys || !lead) throw new Error("infosys document missing lead bullet");
  const foreign: CVDocument = {
    ...document,
    experiences: [
      {
        ...infosys,
        bullets: [
          { ...lead, text: "Built Java services.", evidenceRefs: [tcs0] },
          ...infosys.bullets.slice(1),
        ],
      },
      ...document.experiences.slice(1),
    ],
  };
  assert.throws(
    () => validateClaims({ document: foreign, profile, bank }),
    error => error instanceof Error && error.message === "Experience locality: cited exp-tcs on exp-infosys",
  );
});

test("technologies used are optional per experience and must cite local evidence", () => {
  const profile = twoEmployerProfile();
  const bank = buildEvidenceBank(profile);
  const document = twoEmployerDocument(profile, bank);
  assert.equal(validateClaims({ document, profile, bank }), document);
  assert.deepEqual(document.experiences.map(experience => experience.technologiesUsed?.map(technology => technology.name)), [["Java"], undefined]);

  const tcs0 = requireRef(itemOf(bank, { kind: "experience", entityId: "exp-tcs", bulletIndex: 0 }), "tcs");
  const infosys = document.experiences[0];
  if (!infosys) throw new Error("infosys document missing");
  const foreign: CVDocument = {
    ...document,
    experiences: [
      { ...infosys, technologiesUsed: [{ name: "Payments", evidenceRefs: [tcs0] }] },
      ...document.experiences.slice(1),
    ],
  };
  assert.throws(
    () => validateClaims({ document: foreign, profile, bank }),
    error => error instanceof Error && error.message === "Technology locality: cited experience:exp-tcs:bullet:0 on exp-infosys",
  );
});

test("cover letter paragraph citing two experience refs does not throw", () => {
  const profile = twoEmployerProfile();
  const bank = buildEvidenceBank(profile);
  const document = twoEmployerDocument(profile, bank);
  const infosys0 = requireRef(itemOf(bank, { kind: "experience", entityId: "exp-infosys", bulletIndex: 0 }), "infosys 30%");
  const tcs0 = requireRef(itemOf(bank, { kind: "experience", entityId: "exp-tcs", bulletIndex: 0 }), "tcs");
  const combined: CVDocument = {
    ...document,
    coverLetter: {
      ...document.coverLetter,
      paragraphs: [{
        text: "I cut gold-ledger query time at Infosys and shipped payment APIs at TCS.",
        evidenceRefs: [infosys0, tcs0],
      }],
    },
  };
  assert.equal(validateClaims({ document: combined, profile, bank }), combined);
});

test("experience bullet that names a different profile employer throws", () => {
  const profile = twoEmployerProfile();
  const bank = buildEvidenceBank(profile);
  const document = twoEmployerDocument(profile, bank);
  const infosys = document.experiences[0];
  if (!infosys?.bullets[1]) throw new Error("infosys document missing java bullet");
  const named: CVDocument = {
    ...document,
    experiences: [
      {
        ...infosys,
        bullets: infosys.bullets.map((bullet, index) => (
          index === 1 ? { ...bullet, text: "Built Java services at TCS." } : bullet
        )),
      },
      ...document.experiences.slice(1),
    ],
  };
  assert.throws(
    () => validateClaims({ document: named, profile, bank }),
    error => error instanceof Error && error.message === "Experience bullet names another employer: TCS",
  );
});

test("runWriter inflated number repairs once then StructuredOutputError", async () => {
  const profile = writerEvalProfile();
  const context = buildAgentCandidateContext({ profile, writingStyle: "Short sentences." });
  const fixture = paymentsWriterFixture();
  const inflated = inflatedPaymentsDocument();
  const prompts: string[] = [];
  const document = await runWriter({
    context,
    strategy: fixture.strategy,
    posting: fixture.posting,
    direction: fixture.direction,
    profile,
    execute: queuedExecutor([JSON.stringify(inflated), JSON.stringify(fixture.document)], prompts),
  });
  assert.equal(document.experiences[0]?.bullets[0]?.text, fixture.document.experiences[0]?.bullets[0]?.text);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /Unsupported number: 50%/);

  let calls = 0;
  await assert.rejects(
    () => runWriter({
      context,
      strategy: fixture.strategy,
      posting: fixture.posting,
      direction: fixture.direction,
      profile,
      execute: async () => {
        calls += 1;
        return JSON.stringify(inflated);
      },
    }),
    error => error instanceof StructuredOutputError && error.attempts === 2,
  );
  assert.equal(calls, 2);
});

test("30 percent matches cited 30%", () => {
  const profile = writerEvalProfile();
  const bank = buildEvidenceBank(profile);
  const document = paymentsWriterFixture().document;
  const experience = document.experiences[0];
  const lead = experience?.bullets[0];
  if (!experience || !lead) throw new Error("payments fixture missing lead bullet");
  const rewritten: CVDocument = {
    ...document,
    experiences: [{
      ...experience,
      bullets: [
        { ...lead, text: lead.text.replace("30%", "30 percent") },
        ...experience.bullets.slice(1),
      ],
    }],
  };
  assert.equal(validateClaims({ document: rewritten, profile, bank }), rewritten);
});

test("empty profile documents still go through validateCVDocument", () => {
  const profile = createEmptyProfile();
  const bank = buildEvidenceBank(profile);
  const document: CVDocument = {
    summary: { text: "Backend engineer.", evidenceRefs: [] },
    experiences: [{
      experienceId: "missing-role",
      bullets: [{ text: "Invented employer work.", evidenceRefs: [], transformation: "rewrite" }],
    }],
    skillIds: [],
    projects: [],
    coverLetter: { subject: "Engineer", paragraphs: [{ text: "Hello.", evidenceRefs: [] }] },
  };
  assert.throws(
    () => validateClaims({ document, profile, bank }),
    /Unknown experienceId: missing-role/,
  );
});
