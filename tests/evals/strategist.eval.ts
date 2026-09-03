import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerationDirection, Rank, StructuredProfile } from "../../src/shared.js";
import type { ApplicationStrategy } from "../../src/server/agents/types.js";

export const strategistEvalFixtureNames = ["java-backend", "platform", "applied-ai", "sre", "fullstack"] as const;
export type StrategistEvalFixtureName = (typeof strategistEvalFixtureNames)[number];

export type StrategistEvalFixture = {
  posting: string;
  rank: Rank;
  direction: GenerationDirection;
  profile: StructuredProfile;
  mustIdentify: string[];
  acceptableEvidenceRefs: string[];
  expectedGaps: string[];
  mustNotGap: string[];
};

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadStrategistFixture(name: StrategistEvalFixtureName): StrategistEvalFixture {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8")) as StrategistEvalFixture;
}

export function loadStrategistFixtures() {
  return strategistEvalFixtureNames.map(name => ({ name, fixture: loadStrategistFixture(name) }));
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function matchesLabel(value: string, label: string) {
  const haystack = normalize(value);
  const needle = normalize(label);
  if (haystack.includes(needle)) return true;
  return needle.split(/[/,]+/).map(part => part.trim()).filter(Boolean).every(part => haystack.includes(part));
}

function requirementFor(strategy: ApplicationStrategy, label: string) {
  return strategy.requirements.find(requirement => matchesLabel(requirement.requirement, label));
}

export function scoreStrategist(strategy: ApplicationStrategy, fixture: StrategistEvalFixture) {
  const failures: string[] = [];
  const identified = [
    strategy.positioning,
    strategy.targetRole,
    ...strategy.primarySellingPoints.map(point => point.angle),
    ...strategy.requirements.map(requirement => requirement.requirement),
  ].join("\n");

  for (const label of fixture.mustIdentify) {
    if (!matchesLabel(identified, label)) failures.push(`missing requirement: ${label}`);
    const requirement = requirementFor(strategy, label);
    if (requirement?.candidateFit === "gap") failures.push(`gapped mustIdentify: ${label}`);
  }

  for (const label of fixture.expectedGaps) {
    const requirement = requirementFor(strategy, label);
    const listed = strategy.genuineGaps.some(gap => matchesLabel(gap, label));
    if (requirement && requirement.candidateFit !== "gap") failures.push(`${label} should be gap, got ${requirement.candidateFit}`);
    else if (!requirement && !listed) failures.push(`missing expected gap: ${label}`);
  }

  for (const label of fixture.mustNotGap) {
    const requirement = requirementFor(strategy, label);
    if (requirement?.candidateFit === "gap") failures.push(`must not gap: ${label}`);
    if (strategy.genuineGaps.some(gap => matchesLabel(gap, label))) failures.push(`must not gap genuineGaps: ${label}`);
  }

  return { ok: failures.length === 0, failures };
}
