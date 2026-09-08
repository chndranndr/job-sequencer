import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedScenarioReport,
  runAgentEvalScenario,
  scenarioNames,
  trajectoryEvalScenarios,
  type AgentEvalAction,
  type AgentEvalReport,
} from "./evals/trajectory.eval.js";


function actionSignature(action: AgentEvalAction): string {
  if (action.kind === "search") return `search:${action.source}:${action.query}:${action.location ?? ""}`;
  if (action.kind === "detail") return `detail:${action.source}:${action.resultId}`;
  if (action.kind === "inspect") return "inspect";
  return `finish:${action.reasonCategory ?? ""}`;
}

function reportMetrics(reports: readonly AgentEvalReport[]) {
  let searchCalls = 0;
  let detailCalls = 0;
  let duplicateRate = 0;
  let unique = 0;
  let promising = 0;
  let labelled = 0;
  let precisionAt10 = 0;
  let adaptations = 0;
  let policyViolations = 0;
  let unnecessarySearches = 0;
  for (const report of reports) {
    const searches = report.observability.attempts.filter((attempt) => attempt.operation === "search");
    const details = report.observability.attempts.filter((attempt) => attempt.operation === "detail");
    searchCalls += searches.length;
    detailCalls += details.length;
    duplicateRate += searches.length ? searches.reduce((sum, attempt) => sum + (attempt.duplicateRate ?? 0), 0) / searches.length : 0;
    unique += searches.reduce((sum, attempt) => sum + (attempt.uniqueResultCount ?? 0), 0);
    promising += searches.reduce((sum, attempt) => sum + (attempt.promisingResultCount ?? 0), 0);
    adaptations += report.observability.adaptations.length > 0 ? 1 : 0;
    policyViolations += report.observability.policyEvents.length;
    unnecessarySearches += searches.filter((attempt) => (attempt.uniqueResultCount ?? 0) === 0).length;
    if (report.relevanceLabels > 0) {
      labelled += 1;
      precisionAt10 += report.precisionAt10 ?? 0;
    }
  }
  const count = reports.length || 1;
  return {
    policyViolations,
    terminationRate: reports.filter((report) => report.observability.termination !== null).length / count,
    adaptationRate: adaptations / count,
    averageSearchCalls: searchCalls / count,
    averageDetailCalls: detailCalls / count,
    duplicateRate: duplicateRate / count,
    uniqueYield: unique / count,
    promisingYield: promising / count,
    detailFetchPrecision: reports.reduce((sum, report) => {
      const details = report.observability.attempts.filter((attempt) => attempt.operation === "detail");
      return sum + (details.length ? details.filter((attempt) => attempt.status === "completed").length / details.length : 0);
    }, 0) / count,
    unnecessarySearchRate: unnecessarySearches / Math.max(1, searchCalls),
    ...(labelled ? { precisionAt10: precisionAt10 / labelled } : {}),
  };
}

test("all trajectory evaluation scenarios stay deterministic and bounded", async () => {
  assert.deepEqual(scenarioNames(), [
    "adaptive-query",
    "selective-enrichment",
    "bounded-rejections",
    "provenance-boundary",
    "prompt-injection-data",
    "self-termination",
    "dynamic-source",
    "memory-preference",
  ]);
  const reports = await Promise.all(trajectoryEvalScenarios.map(runAgentEvalScenario));
  for (let index = 0; index < trajectoryEvalScenarios.length; index += 1) {
    const scenario = trajectoryEvalScenarios[index];
    const report = reports[index];
    assert.equal(report.passed, true, `${scenario.id}: ${report.failures.join(", ")}`);
    if (scenario.baseline) assert.deepEqual(report.actionSignatures, scenario.baseline.map(actionSignature), `${scenario.id}: deterministic baseline changed`);
    assert.ok(report.actions.length <= 20);
    assert.ok(report.failures.every(failure => failure.length <= 240));
    if (scenario.id === "selective-enrichment") {
      assert.equal(scenario.actions.some((action) => action.kind === "inspect"), false);
      assert.equal(report.observability.states.length, 1);
      assert.equal(report.observability.sourceStats.freehire?.promisingCount, 1);
      assert.equal(report.observability.sourceStats.freehire?.enrichedCount, 2);
      assert.equal(report.observability.states.at(-1)?.remaining?.maxSearchCalls, 4);
      assert.equal(report.observability.states.at(-1)?.remaining?.maxDetailCalls, 3);
    }
  }
  console.log(JSON.stringify({
    scenarios: { passed: reports.filter(item => item.passed).length, failed: reports.filter(item => !item.passed).length },
    metrics: reportMetrics(reports),
    cases: boundedScenarioReport(reports),
  }));
});
