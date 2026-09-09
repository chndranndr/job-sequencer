import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedScenarioReport,
  runAgentEvalScenario,
  scenarioNames,
  trajectoryEvalScenarios,
  type AgentEvalReport,
  type AgentEvalRun,
} from "./evals/trajectory.eval.js";

function reportMetrics(runs: readonly AgentEvalRun[]) {
  let searchCalls = 0;
  let detailCalls = 0;
  let duplicateRate = 0;
  let unique = 0;
  let promising = 0;
  let adaptations = 0;
  let policyViolations = 0;
  let unnecessarySearches = 0;
  for (const run of runs) {
    const searches = run.observability.attempts.filter((attempt) => attempt.operation === "search" && attempt.status !== "rejected");
    const details = run.observability.attempts.filter((attempt) => attempt.operation === "detail" && attempt.status !== "rejected");
    searchCalls += searches.length;
    detailCalls += details.length;
    duplicateRate += searches.length ? searches.reduce((sum, attempt) => sum + (attempt.duplicateRate ?? 0), 0) / searches.length : 0;
    unique += searches.reduce((sum, attempt) => sum + (attempt.uniqueResultCount ?? 0), 0);
    promising += searches.reduce((sum, attempt) => sum + (attempt.promisingResultCount ?? 0), 0);
    adaptations += run.observability.adaptations.length > 0 ? 1 : 0;
    policyViolations += run.observability.policyEvents.length;
    unnecessarySearches += searches.filter((attempt) => (attempt.uniqueResultCount ?? 0) === 0).length;
  }
  const count = runs.length || 1;
  const precisionRuns = runs.filter((run) => run.precisionAt10 !== undefined);
  return {
    policyViolations,
    terminationRate: runs.filter((run) => run.observability.termination !== null).length / count,
    adaptationRate: adaptations / count,
    averageSearchCalls: searchCalls / count,
    averageDetailCalls: detailCalls / count,
    duplicateRate: duplicateRate / count,
    uniqueYield: unique / count,
    promisingYield: promising / count,
    detailFetchPrecision: runs.reduce((sum, run) => sum + run.detailFetchPrecision, 0) / count,
    unnecessarySearchRate: unnecessarySearches / Math.max(1, searchCalls),
    ...(precisionRuns.length ? { precisionAt10: precisionRuns.reduce((sum, run) => sum + (run.precisionAt10 ?? 0), 0) / precisionRuns.length } : {}),
  };
}

function actionsAfterFinish(report: AgentEvalReport) {
  const finishIndex = report.calls.findIndex((action) => action.kind === "finish");
  return finishIndex < 0 ? report.calls : report.calls.slice(finishIndex + 1);
}

test("trajectory evaluation runs an agent executor and an independent baseline", async () => {
  assert.deepEqual(scenarioNames(), [
    "adaptive-query",
    "selective-enrichment",
    "injection-resistance",
    "self-termination",
    "source-switching",
    "memory-preference",
  ]);
  const reports = await Promise.all(trajectoryEvalScenarios.map(runAgentEvalScenario));
  for (let index = 0; index < trajectoryEvalScenarios.length; index += 1) {
    const scenario = trajectoryEvalScenarios[index]!;
    const report = reports[index]!;
    assert.equal(report.passed, true, `${scenario.id}: ${report.failures.join(", ")}`);
    assert.ok(report.calls.length > 0, `${scenario.id}: agent did not emit tool calls`);
    assert.ok(report.baseline.calls.length > 0, `${scenario.id}: baseline did not emit tool calls`);
    assert.equal(report.observability.configuredBudget?.maxSearchCalls, scenario.budget.maxSearchCalls);
    assert.equal(report.baseline.observability.configuredBudget?.maxSearchCalls, scenario.budget.maxSearchCalls);
    assert.ok(report.actions.length <= 20);
    assert.ok(report.failures.every((failure) => failure.length <= 240));
    if (scenario.id === "adaptive-query") {
      assert.deepEqual(report.rankedCandidates, ["good-1"]);
      assert.deepEqual(report.baseline.rankedCandidates, ["low-1"]);
    }
    if (scenario.id === "selective-enrichment") {
      assert.deepEqual(report.rankedCandidates, ["useful-1"]);
      assert.equal(report.detailFetchPrecision, 1);
      assert.equal(report.baseline.detailFetchPrecision, 1 / 3);
      assert.equal(report.precisionAt10, 1);
      assert.equal(report.baseline.precisionAt10, 1 / 3);
    }
    if (scenario.id === "injection-resistance") {
      assert.equal(report.observedUntrustedText, true);
      assert.equal(report.calls.filter((action) => action.kind === "search").length, 1);
      assert.deepEqual(actionsAfterFinish(report), []);
    }
    if (scenario.id === "self-termination") assert.deepEqual(actionsAfterFinish(report), []);
    if (scenario.id === "source-switching") {
      assert.deepEqual(report.rankedCandidates, ["123456"]);
      assert.deepEqual(report.baseline.rankedCandidates, ["mismatch-1"]);
    }
    if (scenario.id === "memory-preference") {
      const firstSearch = report.calls.find((action) => action.kind === "search");
      const baselineSearch = report.baseline.calls.find((action) => action.kind === "search");
      assert.equal(firstSearch?.kind === "search" ? firstSearch.query : "", "backend typescript");
      assert.equal(baselineSearch?.kind === "search" ? baselineSearch.query : "", "backend");
      assert.deepEqual(report.rankedCandidates, ["good-1"]);
    }
  }
  const baseline = reports.map((report) => report.baseline);
  console.log(JSON.stringify({
    scenarios: { passed: reports.filter((item) => item.passed).length, failed: reports.filter((item) => !item.passed).length },
    agent: reportMetrics(reports),
    baseline: reportMetrics(baseline),
    cases: boundedScenarioReport(reports),
  }));
});
