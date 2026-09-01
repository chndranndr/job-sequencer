import { evidenceRef, type AtsReview, type CVDocument, type EvidenceBank } from "../../src/server/agents/types.js";

export function atsFixture(bank: EvidenceBank, document: CVDocument): { posting: string; review: AtsReview } {
  const ref = bank.items[0]?.ref ?? evidenceRef("skill:java");
  return {
    posting: "Java backend role with Kafka.",
    review: { issues: [{ requirement: "Java", kind: "missing_but_supported", evidenceRefs: [ref], note: "Supported but absent from the draft." }], summary: "One supported requirement is missing." },
  };
}
