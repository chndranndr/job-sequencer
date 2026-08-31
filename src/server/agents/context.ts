import type { StructuredProfile } from "../../shared.js";
import { buildEvidenceBank } from "./evidence.js";
import type { AgentCandidateContext } from "./types.js";

export function buildAgentCandidateContext(input: { profile: StructuredProfile; writingStyle: string }): AgentCandidateContext {
  return {
    evidenceBank: buildEvidenceBank(input.profile),
    preferences: {
      targetRoles: [...input.profile.workPreferences.targetRoles],
      workPreferences: input.profile.workPreferences,
    },
    writingStyle: input.writingStyle,
  };
}
