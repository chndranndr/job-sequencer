import { evidenceRef, type ApplicationStrategy, type Critique, type CVDocument } from "../../src/server/agents/types.js";
import { defaultGenerationDirection, type GenerationDirection } from "../../src/shared.js";
import { platformWriterFixture } from "./writer.eval.js";

export type CriticEvalFixture = {
  name: "on_strategy" | "generic";
  posting: string;
  direction: GenerationDirection;
  strategy: ApplicationStrategy;
  document: CVDocument;
  expected: { minScore?: number; maxScore?: number; issueDimension?: Critique["issues"][number]["dimension"] };
};

export function onStrategyCriticFixture(): CriticEvalFixture {
  const fixture = platformWriterFixture();
  return { ...fixture, name: "on_strategy", direction: defaultGenerationDirection, expected: { minScore: 7 } };
}

export function genericCriticFixture(): CriticEvalFixture {
  const fixture = platformWriterFixture();
  return {
    ...fixture,
    name: "generic",
    direction: defaultGenerationDirection,
    document: {
      ...fixture.document,
      summary: { text: "Experienced engineer who delivers reliable software.", evidenceRefs: [evidenceRef("identity:summary")] },
      experiences: [{
        experienceId: "exp-aetherwave",
        bullets: [{ text: "Worked on software and supported team delivery.", evidenceRefs: [evidenceRef("experience:exp-aetherwave:bullet:0")], transformation: "rewrite" }],
      }],
      coverLetter: {
        subject: "Engineer",
        paragraphs: [{ text: "I am excited to contribute my engineering experience.", evidenceRefs: [evidenceRef("identity:summary")] }],
      },
    },
    expected: { maxScore: 6, issueDimension: "relevance" },
  };
}

export function scoreCritique(critique: Critique, expected: CriticEvalFixture["expected"]) {
  const failures: string[] = [];
  if (expected.minScore !== undefined && critique.score < expected.minScore) failures.push(`score below ${expected.minScore}`);
  if (expected.maxScore !== undefined && critique.score > expected.maxScore) failures.push(`score above ${expected.maxScore}`);
  if (expected.issueDimension && !critique.issues.some(issue => issue.dimension === expected.issueDimension)) failures.push(`missing ${expected.issueDimension} issue`);
  return { ok: failures.length === 0, failures };
}
