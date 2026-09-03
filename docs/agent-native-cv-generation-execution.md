# Agent-native CV generation execution

Run the program in `docs/agent-native-cv-generation-plan.md`. This file is owners, Graphite, audit ticks, and receipts. Architecture and acceptance live in the plan.

The operator replaced the default ten-lane floor. Verify each PR with the risk table in the plan. Do not pad AG-1 with DISK and PATTERN lanes.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator lands the stack. Owners stop at STACK-READY.

## Arm the program

- [ ] State this protocol and the product plan to the operator, then stop. Start execution only on her explicit go.
- [ ] On her go, arm a `/goal` with this exact text. "docs/agent-native-cv-generation-plan.md plus docs/agent-native-cv-generation-execution.md. Stack AG-1 through AG-7 first. Then branch AG-8, AG-9, AG-10, and AG-12. Operator lands the Graphite stack. Done when generate writes a CV from CVDocument with evidence refs, bounded automatic revision, manual revise without a fixed cap, inspectable strategy.json, and a failed compile leaves current/ untouched. Verify with the plan risk table, not ten generic browser lanes."
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:.cursor/skills/verify-job-sequencer/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:docs/agent-native-cv-generation-plan.md`
- [ ] Arm the 30-minute audit tick. In a local session, a real terminal `/loop`. In a cloud root, a cloud-sleeper wake chain.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk and the armed /goal. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then send the operator a status message, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

## Spawn owners

- [ ] Spawn one owner per PR with the autopilot-stack lifecycle.
- [ ] Follow the product plan graph. AG-1 through AG-7 are a stack. After AG-7 merges, AG-8, AG-9, AG-10, and AG-12 may run as parallel stacked branches off AG-7. AG-11 follows AG-9. AG-13 follows AG-8. AG-14 waits for those heads.
- [ ] Hold file boundaries. `src/server/generation.ts` has one owner at a time through AG-7. AG-10 may edit TRACE, `src/tracker/agent.tsx`, and `src/shared.ts` fallback generate rows. Do not write steps into `runs.summary_json`. AG-12 and AG-13 must not edit the writer.
- [ ] Hold the review gate. AG-10 waits for screenshots and a video in chat.

## PR mechanics

- [ ] Open the PR ready, never draft.
- [ ] Run `npm run typecheck` and `npm test` before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage Bugbot and security-reviewer comments per `pstack/skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before babysit and again before the merge-ready report.

## Verdict

- [ ] At the merge-ready head SHA, run the checks the product plan names for that PR. Gates are unit, eval, live, and recorded cost where the table says so.
- [ ] Swarm live lanes only when the plan names a live generate or TRACE interaction. Do not invent ten Tracker smokes.
- [ ] Clean only when those named checks pass. A new head gets a fresh verdict.
- [ ] The root appends the PR to the Graphite stack. The operator lands it. After restack, compare `git patch-id` to the verdict SHA.

## Live boot recipe

Use this only for PRs whose live column is not empty.

Drive through `.cursor/skills/verify-job-sequencer/SKILL.md`.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] From the repo root run `npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts launch`. Wait until doctor title is `TRACKER - Job Sequencer` and `isolated` is true.
- [ ] Run doctor. Refuse the lane if it fails.
- [ ] Deliver input only through `control-job-sequencer.ts browser` and `api`.
- [ ] Save screenshots under `artifacts/verify-job-sequencer/proof/agent-native/<pr-id>/`.
- [ ] Generate lanes need Pi auth in `%USERPROFILE%\.pi\agent\auth.json`. Fail the lane if doctor-plus-auth is missing.
- [ ] After the lane, run cleanup.

## Per-PR receipts

Copy the product plan's **Verify** line. Do not add extra Tracker pages.

**AG-1.** `tests/agents-evidence.test.ts`. One DISK persist smoke.

**AG-2.** `tests/agents-strategist.test.ts`, `tests/evals/strategist.eval.ts`, `tests/injection.test.ts`. Three fixture generates. `strategy.json` on disk. Log latency, tokens, cost. No duration ratio fail.

**AG-3.** Writer unit and eval. Two jobs, two narratives, same candidate. PDFs stay within the configured maxima of 2 CV pages and 1 letter page. Log tokens.

**AG-4.** Claim-validator unit. One generate.

**AG-5.** Auditor unit and eval. One generate. Log latency.

**AG-6.** Critic unit and eval. One generate. Log latency.

**AG-7.** Reviser unit and eval. One full generate. Log agent calls and wall time.

**AG-8.** Latex unit. One PDF compile. Log compile time.

**AG-9.** Publish unit. Success generate plus compile-fail fixture that leaves `current/` intact.

**AG-10.** TRACE unit. Live TRACE during generate. Operator review of screenshots and a 30 to 60 second video.

**AG-11.** ATS unit and eval. One generate.

**AG-12.** Research unit. Generate with research off. Log duration.

**AG-13.** Visual unit. One generate. Skip raster if missing.

**AG-14.** Fixture gate. One generate plus Approve. Stage Ready, not Applied.

## Close

- [ ] AG-1 through AG-7 landed with eval receipts.
- [ ] Branched PRs landed with their named checks.
- [ ] Reply with stack links, head SHAs, eval numbers, and open gates.
