import type { Critique, CVDocument } from "../../src/server/agents/types.js";
import { genericCriticFixture, onStrategyCriticFixture } from "./critic.eval.js";

export type RevisionEvalFixture = {
  draft1: CVDocument;
  draft2: CVDocument;
  critique1: Critique;
  critique2: Critique;
};

export function revisionEvalFixture(): RevisionEvalFixture {
  return {
    draft1: genericCriticFixture().document,
    draft2: onStrategyCriticFixture().document,
    critique1: { score: 5, issues: [{ severity: "high", dimension: "relevance", note: "The draft is generic." }], summary: "Needs a clearer platform focus." },
    critique2: { score: 8, issues: [], summary: "Specific and aligned." },
  };
}

export function scoreRevision(fixture: RevisionEvalFixture) {
  const failures: string[] = [];
  if (fixture.critique2.score < fixture.critique1.score) failures.push("draft 2 score should not regress");
  if (fixture.draft1.summary.text === fixture.draft2.summary.text) failures.push("draft 2 should revise the summary");
  return { ok: failures.length === 0, failures };
}
