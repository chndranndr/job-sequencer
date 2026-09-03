import test from "node:test";
import assert from "node:assert/strict";
import { loadStrategistFixtures } from "./evals/strategist.eval.js";
import { buildEvidenceBank } from "../src/server/agents/evidence.js";
import { validateClaims } from "../src/server/agents/claim-validator.js";
import type { CVDocument } from "../src/server/agents/types.js";

test("all agent fixtures produce a zero-unsupported-claim baseline", () => {
  for (const { name, fixture } of loadStrategistFixtures()) {
    const bank = buildEvidenceBank(fixture.profile);
    const byEntity = (entityId: string) => bank.items.filter(item => item.source.entityId === entityId);
    const summaryRefs = bank.items.filter(item => item.ref === "identity:summary").map(item => item.ref);
    const document: CVDocument = {
      summary: { text: fixture.profile.identity.summary || "Backend engineer.", evidenceRefs: summaryRefs },
      experiences: fixture.profile.experience.filter(entry => entry.title || entry.company || entry.description).map(entry => ({
        experienceId: entry.id,
        bullets: byEntity(entry.id).filter(item => item.kind === "experience").map(item => ({ text: item.text, evidenceRefs: [item.ref], transformation: "rewrite" as const })),
      })),
      skillIds: fixture.profile.skills.filter(entry => entry.name.trim()).map(entry => entry.id),
      projects: fixture.profile.projects.filter(entry => entry.name || entry.role || entry.description).map(entry => ({ projectId: entry.id, bullets: byEntity(entry.id).filter(item => item.kind === "project").map(item => ({ text: item.text, evidenceRefs: [item.ref] })) })),
      coverLetter: { subject: fixture.profile.identity.headline || "Application", paragraphs: [{ text: fixture.profile.identity.summary || "I am applying.", evidenceRefs: summaryRefs }] },
    };
    assert.doesNotThrow(() => validateClaims({ document, profile: fixture.profile, bank }), name);
  }
});
