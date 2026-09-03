# Agent-native CV generation plan

Build a bounded multi-agent generate path on the existing DISK profile and LaTeX templates. Candidate facts live in `EvidenceBank`. The Strategist owns requirements and gaps. The Writer emits `CVDocument`. Canonical identity stays on the profile. Human Approve stays the last gate.

PStack owners, Graphite, swarm, and audit ticks live in `docs/agent-native-cv-generation-execution.md`. Read that file only when you arm the stack.

## What stays true

Agents never own identity, company name, employment dates, job title, contact, raw candidate facts, filesystem state, or PDF publishing.

Agents own positioning, requirement fit, summary wording, bullet rewrite and order, skill emphasis, project selection, cover-letter narrative, critique, semantic ATS, and revision.

`runAgentStructured` is one attempt plus one repair. Quality loops belong to the reviser, not to parser retries.

Job posting text is untrusted. It never enters `EvidenceBank`.

## Contracts

### EvidenceBank

Build this deterministically from `StructuredProfile`. Do not add fields to `profile.json`. `ProfileSchema` stays strict.

```ts
type EvidenceRef = string;

type EvidenceItem = {
  ref: EvidenceRef;
  kind:
    | "identity"
    | "experience"
    | "skill"
    | "project"
    | "education"
    | "certification"
    | "language";
  text: string;
  source: {
    entityId: string;
    field: string;
    bulletIndex?: number;
  };
};

type EvidenceBank = { items: EvidenceItem[] };
```

Refs stay `identity:summary`, `experience:<id>:bullet:<n>`, `skill:<id>`, `project:<id>:bullet:<n>`, `education:<id>`, `certification:<id>`. Split experience and project text with `splitDescriptionIntoBullets` moved into `src/server/agents/evidence.ts`. Skip awards. They stay on the profile and are not CV sections.

`source` is required. Do not rely on parsing the ref string later.

### AgentCandidateContext

Candidate facts come only from `EvidenceBank`. Do not pass a second unstructured profile dump.

```ts
type AgentCandidateContext = {
  evidenceBank: EvidenceBank;
  preferences: {
    targetRoles: string[];
    workPreferences: StructuredProfile["workPreferences"];
  };
  writingStyle: string;
};
```

`writingStyle` is `loadGuidance(["writingStyle"])`. It is style, not evidence.

### ApplicationStrategy

The Strategist reads the job posting, `AgentCandidateContext`, advisory `Rank`, and `GenerationDirection`. It does not write a CV.

```ts
type StrategyRequirement = {
  requirement: string;
  importance: "critical" | "important" | "nice_to_have";
  candidateFit: "strong" | "partial" | "gap";
  evidenceRefs: EvidenceRef[];
};

type ApplicationStrategy = {
  positioning: string;
  targetRole: string;
  primarySellingPoints: Array<{ angle: string; evidenceRefs: EvidenceRef[] }>;
  requirements: StrategyRequirement[];
  narrativeGuidance: string[];
  deEmphasize: string[];
  genuineGaps: string[];
  rankDisagreements: Array<{
    rankGap: string;
    strategistFit: StrategyRequirement["candidateFit"];
    note: string;
  }>;
};
```

`Rank` from `jobs.rank_json` is an input signal. It is not a constraint. Do not reject a strategy because `genuineGaps` is not a subset of `rank.gaps`.

Hard validation:

- `candidateFit` `strong` or `partial` requires at least one valid `EvidenceRef`.
- `candidateFit` `gap` requires empty `evidenceRefs`.
- Every `EvidenceRef` exists in the bank.
- No requirement text is copied from the job posting as a candidate claim.

If `rank.gaps` says gap and the Strategist says `strong` or `partial`, append `rankDisagreements`. That is a warning, not a fail.

### CVDocument

The Writer emits this. Canonical company, title, dates, location, contact, and education institution stay on the profile.

```ts
type CVDocument = {
  summary: { text: string; evidenceRefs: EvidenceRef[] };
  experiences: Array<{
    experienceId: string;
    bullets: Array<{
      text: string;
      evidenceRefs: EvidenceRef[];
      transformation: "rewrite" | "compress" | "combine";
    }>;
  }>;
  skillIds: string[];
  projects: Array<{
    projectId: string;
    bullets?: Array<{ text: string; evidenceRefs: EvidenceRef[] }>;
  }>;
  coverLetter: {
    subject: string;
    paragraphs: Array<{ text: string; evidenceRefs: EvidenceRef[] }>;
  };
};
```

`validateCVDocument` checks ids and refs against the bank and the profile. `validateClaims` hard-fails unsupported numbers and locality breaks.

## Eval strategy

Start the eval suite in AG-2. Do not wait for AG-14.

```text
tests/evals/
  fixtures/
    java-backend.json
    platform.json
    applied-ai.json
    sre.json
    fullstack.json
  strategist.eval.ts
  writer.eval.ts
  auditor.eval.ts
  critic.eval.ts
  revision.eval.ts
```

Each fixture names a job posting, the candidate bank, and labels.

```ts
{
  mustIdentify: ["Java/Spring", "distributed systems"],
  acceptableEvidenceRefs: string[],
  expectedGaps: ["Go"],
  mustNotGap: ["event-driven architecture"]
}
```

Keyword smoke is not enough. Include at least these two Strategist cases.

Event-driven JD with Kafka, Artemis, async webhooks, idempotent payments, and Redis locking. Expect `strong` or `partial` on event-driven systems. Fail if the Strategist gaps it because the literal phrase is missing.

Go production JD with a Java, Scala, and Python bank. Expect `gap`. Fail if the Strategist marks `partial` only because those are programming languages.

Record per run, as observation, not as a 2.2x fail against the old single-shot path:

- strategist latency, input tokens, output tokens, cost
- full generate agent call count, total tokens, wall time

Milestone quality bars, once Writer exists:

- Strategist quality has a fixture baseline
- Writer relevance has a fixture baseline
- Hard claims stay at 100 percent on `validateClaims`
- Draft 2 critic score is at or above draft 1 when a revision runs

## Dependency graph

AG-1 through AG-7 stay linear. They share `src/server/generation.ts`.

```text
AG-1 domain
  → AG-2 strategist
    → AG-3 writer
      → AG-4 claims
        → AG-5 auditor
          → AG-6 critic
            → AG-7 revision
```

After AG-7 the `CVDocument` contract is stable. Branch.

```text
AG-7
  ├─ AG-8 renderer ─ AG-13 visual QA
  ├─ AG-9 artifacts ─ AG-11 ATS
  ├─ AG-10 TRACE UI
  └─ AG-12 company research (also needs AG-2)
       │
       └─ AG-14 legacy cleanup and eval hardening (after AG-8, AG-9, AG-10, AG-11, AG-12, AG-13)
```

Do not park ATS or TRACE behind Visual QA. Do not park company research behind the renderer.

## Risk-based verification

Use this table instead of ten browser lanes on every PR.

| PR | Unit | Agent eval | Live | Perf |
| --- | --- | --- | --- | --- |
| AG-1 domain | strong | none | one Tracker smoke | none |
| AG-2 strategist | strong | strong | three fixture jobs | record latency, tokens, cost |
| AG-3 writer | strong | very strong | generate two jobs | record latency, tokens |
| AG-4 claims | strong | none | one generate | none |
| AG-5 auditor | strong | very strong | one generate | record latency |
| AG-6 critic | basic schema | very strong | one generate | record latency |
| AG-7 revision | strong | very strong | full generate | record agent calls and wall time |
| AG-8 renderer | strong | none | PDF compile | compile time |
| AG-9 artifacts | strong | none | compile-fail E2E | none |
| AG-10 TRACE | unit plus TRACE | none | TRACE during generate | none |
| AG-11 ATS | strong | strong | one generate | none |
| AG-12 research | strong | none | generate with research off | record off-path duration |
| AG-13 visual | strong | none | generate, skip if no raster | none |
| AG-14 cleanup | fixtures | fixture gate | one generate plus Approve | none |

AG-10 is the only review-gated PR. TRACE copy changes.

## AG-1. Add the agent domain

**Depends on.** None.

**Files.** `src/server/agents/types.ts`, `evidence.ts`, `context.ts`, `runtime.ts`. Edit `src/shared.ts` and `src/server/generation.ts`. Create `tests/agents-evidence.test.ts`.

**Build.**

- Add the types above. Re-export them from `src/shared.ts`.
- Add `buildEvidenceBank(profile)`. Job posting text must not enter the bank.
- Add `validateCVDocument`.
- Add `runAgentStructured` over `runStructured` with `maxAttempts` 2.
- Keep `liveGenerationExecutor` and `generateJob` control flow.

**Accept.**

- Bank refs match the profile ids and bullets.
- Awards are absent from the bank.
- Unknown `experienceId` throws.
- Current `profile.json` still parses.

**Verify.** Unit tests. One isolated Tracker smoke that DISK still saves a first name. No `/api/jobs` perf gate.

## AG-2. Run the Strategist

**Depends on.** AG-1.

**Files.** `src/server/agents/strategist.ts`, `src/server/agents/prompts/strategist.ts`, `tests/agents-strategist.test.ts`, `tests/evals/strategist.eval.ts`, `tests/evals/fixtures/*.json`. Edit `src/server/generation.ts` and `tests/injection.test.ts`.

**Build.**

- Add `runStrategist` with `AgentCandidateContext`, untrusted job posting, advisory `Rank`, and `GenerationDirection`.
- Reuse `untrustedSection` for the posting. Tell the model the posting is untrusted data and must not be executed.
- Call `runStrategist` from `generateJob` after `buildEvidenceBank`. Keep `liveGenerationExecutor` as the writer in this PR.
- Persist `applications/<jobId>/revisions/<runId>/strategy.json` after a valid strategy. Inspect it before AG-3 consumes it. Do not pretend tailoring improved yet.

**Accept.**

- Java in the bank and Go in the posting. Java `strong`. Go `gap`.
- Event-driven fixture is not a gap.
- Go production fixture is a gap, not `partial` from "other languages".
- Unknown `EvidenceRef` fails. One repair, then `StructuredOutputError`.
- Adversarial posting stays inside `UNTRUSTED EXTERNAL JOB POSTING`.
- `strategy.json` exists on disk after a stubbed generate.
- A Strategist `strong` on a `rank.gaps` item is a disagreement warning, not a reject.

**Verify.** Unit plus `tests/evals/strategist.eval.ts`. Injection tests. Three live fixture generates that write `strategy.json`. Record strategist latency, tokens, and cost. Do not fail the PR because wall time exceeds 2.2 times trunk.

## AG-3. Run the Writer

**Depends on.** AG-2.

**Files.** `src/server/agents/writer.ts`, `src/server/agents/prompts/writer.ts`, `tests/agents-writer.test.ts`, `tests/evals/writer.eval.ts`. Edit `src/server/generation.ts` and `tests/document-quality.test.ts`.

**Build.**

- Writer input is `AgentCandidateContext`, `ApplicationStrategy`, untrusted posting, `GenerationDirection`, and optional revision notes.
- Strategy must change summary text, bullet wording, bullet order, `skillIds`, project selection, and cover letter.
- Map `CVDocument` onto the current renderer so AG-3 still compiles. Canonical identity still comes from the profile.
- Read `strategy.json` from the AG-2 path. Do not rebuild strategy from `cvEdits`.

**Accept.**

- Same candidate plus two materially different jobs yields two materially different summaries and lead bullets.
- Unknown employer id fails `validateCVDocument`.
- Company strings in tex still come from `ExperienceEntry.company`.
- CV is at most the configured maximum (two pages by default). Letter is at most the configured maximum (one page by default).

**Verify.** Unit plus writer eval. Two live generates on two fixture jobs. Compare `pdftotext`. Record tokens and latency.

## AG-4. Validate claims

**Depends on.** AG-3.

**Files.** `src/server/agents/claim-validator.ts`, `tests/agents-claim-validator.test.ts`. Edit `src/server/generation.ts`.

**Build.** Hard-fail unsupported numbers, unknown entities, and experience locality. Cover-letter `combine` may cite more than one experience. Do not repair numbers here.

**Accept.** Evidence `30%` versus generated `50%` throws. Infosys bullet citing another employer throws.

**Verify.** Unit. One live generate that still compiles.

## AG-5. Audit facts

**Depends on.** AG-4.

**Files.** `src/server/agents/factual-auditor.ts`, prompts, `tests/agents-factual-auditor.test.ts`, `tests/evals/auditor.eval.ts`.

**Build.** Semantic overclaim, scope inflation, role inflation. Fail closed on `critical`. `maxAttempts` 2.

**Accept.** One reporting workflow claimed as global database performance is `scope_inflation`.

**Verify.** Unit plus auditor eval. One live generate. Record auditor latency.

## AG-6. Critique quality

**Depends on.** AG-5.

**Files.** `src/server/agents/critic.ts`, prompts, `tests/agents-critic.test.ts`, `tests/evals/critic.eval.ts`.

**Build.** Run auditor and critic with `Promise.all`. Do not fail generate on a low score in this PR.

**Verify.** Schema unit plus critic eval. One live generate. Record critic latency.

## AG-7. Revise inside two rounds

**Depends on.** AG-6.

**Files.** `src/server/agents/reviser.ts`, prompts, `tests/agents-reviser.test.ts`, `tests/evals/revision.eval.ts`.

**Build.** `MAX_REVISION_ROUNDS` is 2. Stop on no critical factual issue, critic score at threshold, and no high-severity critic issue. Validate claims after every revision.

**Accept.** Early stop on a clean second audit. Always-failing critic stops at 2. Draft 2 score is at or above draft 1 on the revision eval.

**Verify.** Unit plus revision eval. One full live generate. Record agent call counts and wall time.

## AG-8. Compile CVDocument

**Depends on.** AG-7.

**Files.** `src/server/rendering/cv.ts`, `cover-letter.ts`. Edit `generation.ts`, `tests/document-quality.test.ts`, `tests/latex.test.ts`.

**Build.** Renderer reads `CVDocument` plus profile plus templates. Delete `selectExperienceBullets`, ranking `overlapScore`, `assignCvEdits`, and `backendPlatformBoost` from the writer path.

**Accept.** Skill ids in the document are the skill names in the tex. Identity fields still come from the profile.

**Verify.** Unit. One live PDF compile. Record compile time.

## AG-9. Publish artifacts atomically

**Depends on.** AG-7. May land beside AG-8.

**Files.** `generation.ts`, `documents.ts`, `tests/agents-publish.test.ts`, `tests/phase2.test.ts`.

**Build.** Expand `revisions/<run-id>/` with tex, pdf, strategy, document, audit, review, drafts, and verification. Compile there. `compileAndVerify` throws. Catch it. Promote to `current/` only after success. Stop `archiveCurrent` before compile. Thread `signal` into compile. Do not null `verification_json` until promote succeeds. Leave old `history/` trees in place. `GET /api/files` still serves `current/` only.

**Accept.** A throwing compile leaves previous `current/cv.pdf` bytes unchanged.

**Verify.** Unit plus one live success generate and one compile-fail fixture.

## AG-10. Show generation steps

**Depends on.** AG-7. May land beside AG-8 and AG-9.

**Files.** `src/shared.ts`, `generation.ts`, `src/tracker/trace.tsx`, `src/tracker/agent.tsx`, TRACE tests.

**Build.** Extend `generate:<jobId>:*` task ids. Both TRACE and the Agent Steps tab read `deriveRunTaskRows`. Do not write steps into `runs.summary_json`.

**Verify.** Unit. Live TRACE during one generate. Review-gated. Screenshots and a short video of empty TRACE, a generate, and completed steps.

## AG-11. Review ATS coverage

**Depends on.** AG-9.

**Build.** Deterministic PDF checks for email, phone, employers, dates, `(cid:`, replacement characters, duplicate bullets. Semantic ATS agent with `missing_but_supported` versus `genuine_gap`. One ATS revision for supported omissions. Never invent a genuine gap.

**Verify.** Unit plus ATS eval. One live generate.

## AG-12. Research the company

**Depends on.** AG-2 and AG-7. May land beside AG-8.

**Build.** Optional, default off. Separate Pi session with web tools. Research may change positioning and letter terminology. It must not become `EvidenceBank` items.

**Verify.** Unit. Live generate with research off. Record off-path duration against AG-7.

## AG-13. Review PDF pages

**Depends on.** AG-8.

**Build.** Raster pages, vision QA, one document-level revision. Do not edit LaTeX. Skip if raster tools are missing. Do not fail generate on skip.

**Verify.** Unit. One live generate.

## AG-14. Remove legacy generation and harden evals

**Depends on.** AG-8, AG-9, AG-10, AG-11, AG-12, AG-13.

**Build.** Delete `renderLegacyProfile`. Invalid canonical profile fails closed. Expand fixtures. Unsupported claim rate on fixtures is 0. Approve remains required.

**Verify.** Fixture gate. One live generate plus Approve. Stage stays Ready, not Applied.

## First milestone

Stop calling the core done at AG-7 plus the current renderer.

```text
EvidenceBank → Strategist → Writer → claims → auditor ∥ critic → reviser → CVDocument → existing renderer
```

Intentionally later. Company research, visual QA, ATS agent, workflow engine, parallel job generate, vector database.

AG-3 is the first PR where a user can see the agent path work. Two jobs, two narratives, same candidate.

## Definition of done

- Strategist owns per-job positioning and gaps. `rank.gaps` is advisory.
- Writer rewrites from strategy. Summary is tailored.
- Every candidate claim carries `EvidenceRefs`.
- Unsupported numbers hard-fail.
- Factual auditor catches semantic overclaim.
- Critic scores quality.
- Reviser runs at most twice.
- Renderer does not pick relevance after AG-8.
- Failed compile does not disturb `current/`.
- Structured artifacts exist for debug.
- Human Approve remains the last gate.

## Appendix A. Facts already in trunk

`ProfileEntry.id` exists. `splitDescriptionIntoBullets` is private in `generation.ts`. `runStructured` uses two attempts. Job postings sit in `untrustedSection`. Rank is the `Rank` type on `jobs.rank_json` and is labeled TRUSTED in today's prompt. `archiveCurrent` runs before `compileAndVerify`. Compile throws. Disk history is `history/<stamp>/`. TRACE and `agent.tsx` already show trajectory tasks. Awards are not rendered. `ProfileSchema` is strict.

Still unproven. Writer quality on two real postings. Rename atomicity on this Windows host. Page raster on lane VMs.

## Appendix B. Alternatives rejected

Validating Strategist gaps against `rank.gaps` lost. That keeps scrape rank as the owner of the job.

A second unstructured `profileContext` lost. Facts would leak without refs.

Ten generic Tracker lanes on AG-1 lost. `EvidenceBank` is not on `GET /api/jobs`.

Failing AG-2 at 2.2 times old generate duration lost. The extra call is the feature.

A workflow engine lost. `runStructured` plus two revision rounds is enough.

Putting awards in the bank lost. They are not CV sections.

## Appendix C. Risks

`generation.ts` stays single-writer through AG-7. Restack conflicts are expected.

AG-2 writes `revisions/<runId>/strategy.json` before AG-9 owns that directory. Keep the path stable so AG-9 extends it instead of renaming it.

Rank labeled TRUSTED can bias the Strategist. Keep the posting untrusted. Do not copy rank text into the bank.

Pi auth is required for live generate and evals that call the model.

## Appendix D. Reading list

`src/server/generation.ts` `generateJob`, `archiveCurrent`, `renderStructuredProfile`, `liveGenerationExecutor`.

`src/server/structured.ts` `runStructured`.

`src/server/context.ts` `trustedSection`, `untrustedSection`.

`src/shared.ts` `StructuredProfile`, `Rank`, `deriveRunTaskRows`.

`src/server/documents.ts` `compileAndVerify`.

`src/server/guidance.ts` `writingStyle`.

`.cursor/skills/verify-job-sequencer/SKILL.md` for any live generate.

Execution protocol. `docs/agent-native-cv-generation-execution.md`.
