# Generation direction plan

Chandra aims a CV and letter before Pi writes them, then corrects the draft without leaving Drafting.
`GenerationDirection` lives on the application row.
Configured page values are maximums, so generated documents may be shorter. Short still means denser copy within the configured CV page maximum.
The stack is DIR-1, DIR-2, then DIR-3.
The operator reviews DIR-3 and lands the chain.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator lands DIR-1, DIR-2, and DIR-3. Owners stop at STACK-READY.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on her explicit go.
- [ ] On her go, arm a `/goal` with this exact text. "docs/generation-direction-plan.md. Stack DIR-1, DIR-2, DIR-3. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Operator lands the Graphite stack. Done when SAMPLE generate honors direction, revise stays in Drafting, and manual revise remains available after three revisions."
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `git show origin/main:pstack/skills/swarm/SKILL.md`
  - [ ] `git show origin/main:.cursor/skills/verify-job-sequencer/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `git show origin/main:pstack/skills/technical-writing/SKILL.md`
  - [ ] `git show origin/main:pstack/skills/unslop/SKILL.md`
- [ ] Arm the 30-minute audit tick. In a local session, a real terminal `/loop`. In a cloud root, a cloud-sleeper wake chain. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk and the armed /goal. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then send the operator a status message, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] DIR-1 branches from `main`.
  - [ ] DIR-2 after DIR-1.
  - [ ] DIR-3 after DIR-2.
- [ ] Hold the file boundaries. DIR-1 touches only `src/shared.ts`, `src/server/db.ts`, `src/server/app.ts`, and `tests/generation-direction.test.ts`. DIR-2 touches only `src/server/generation.ts`, `src/server/runs.ts`, `src/server/app.ts`, `tests/phase2.test.ts`, and `tests/document-quality.test.ts`. DIR-3 touches only `src/tracker/sample.tsx`, `src/tracker/order.tsx`, `src/tracker/App.tsx`, `tests/tracker-sample-actions.test.ts`, and `docs/GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md`. DIR-1 adds `PUT /api/jobs/:id/direction` in `app.ts`. DIR-2 changes only the regenerate handler there.
- [ ] Hold the review gate. DIR-3 changes an interaction. It waits for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Open the PR ready, never draft, with `gh pr create` and `draft: false`, or with Graphite `gt` for a stack.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before babysit and again before the merge-ready report.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, run the swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head gets a fresh swarm and a fresh verdict.
- [ ] The root appends the PR to the Graphite stack. The operator lands it. No owner squash-merges. After restack, compare `git patch-id` to the verdict SHA.

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `.cursor/skills/verify-job-sequencer/SKILL.md`.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] From the repo root run `npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts launch`. Wait until doctor title is `TRACKER - Job Sequencer` and `isolated` is true.
- [ ] Run `npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts doctor`. Refuse the lane if doctor fails.
- [ ] Deliver input only through `control-job-sequencer.ts browser` and `control-job-sequencer.ts api`. Read-only diagnostics are doctor, `browser snapshot`, and `GET /api/jobs`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.
- [ ] Lanes that add a job, click Generate, or click Revise need Pi auth in `%USERPROFILE%\.pi\agent\auth.json`. Fail the lane if doctor-plus-auth is missing.
- [ ] After the lane, run `npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts cleanup`.

## Persist generation direction (DIR-1)

**Depends on.** None.

**Files.**

- [ ] Edit `src/shared.ts`.
- [ ] Edit `src/server/db.ts`.
- [ ] Edit `src/server/app.ts`.
- [ ] Create `tests/generation-direction.test.ts`.

**Build.**

- [ ] Add `GenerationDirection` in `src/shared.ts` as a strict object with `cvLength` `short` or `complete`, `cvPagesOverride` integer 1 to 10 or null, `letterMode` `standard` or `exploratory`, `letterNarration` string max 500, `revisionNotes` string max 2000, and `revisionCount` integer 0 or greater.
- [ ] Default is `complete`, `standard`, empty narration, empty notes, and `revisionCount` 0.
- [ ] Add `applications.generation_direction_json` in `src/server/db.ts` and map it on `getJobDetail`.
- [ ] Add `PUT /api/jobs/:id/direction` that writes only for Selected, Drafting, or Ready. Ready writes must not change stage in DIR-1.
- [ ] Reject unknown keys and negative `revisionCount` values. Manual revision count has no upper cap.

**You see.**

- [ ] `GET /api/jobs/:id` includes `generation_direction` with the default after a Selected job exists.
- [ ] `PUT /api/jobs/:id/direction` with `cvLength` `short` returns that value on the next GET.
- [ ] Recommended or Applied PUT returns 409.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/generation-direction.test.ts` covers default, round-trip PUT including a value above the old cap, 409 on Applied, and invalid negative counts. Run `npm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Launch isolated Tracker. Save `dir-1-launch.png`. Pass when the page title is `TRACKER - Job Sequencer`.
- [ ] Lane 2. Open DISK and confirm profile banks. Save `dir-1-disk.png`. Pass when text `DISK · SAMPLE BANK` is visible.
- [ ] Lane 3. Open PATTERN empty state. Save `dir-1-pattern-empty.png`. Pass when `ADD JOB` is enabled.
- [ ] Lane 4. Add a job from PATTERN with a pasted posting, then wait until it is Recommended. Save `dir-1-added.png`. Pass when PATTERN lists one row.
- [ ] Lane 5. `PUT /api/jobs/:id/direction` while the job is still Recommended. Save `dir-1-put-recommended.png`. Pass when the status is 409.
- [ ] Lane 6. Select the job on SAMPLE. Save `dir-1-selected.png`. Pass when SAMPLE shows Generate documents.
- [ ] Lane 7. `GET /api/jobs/:id` after Select. Save `dir-1-default-direction.png`. Pass when `generation_direction.cvLength` is `complete` and `revisionCount` is 0.
- [ ] Lane 8. PUT `cvLength` `short`. Save `dir-1-put-short.png`. Pass when the next GET returns `cvLength` `short` and stage is still Selected.
- [ ] Lane 9. Open ORDER. Save `dir-1-order.png`. Pass when text `ORDER LIST` is visible and the Selected job is listed.
- [ ] Lane 10. Cleanup then relaunch. Save `dir-1-relaunch.png`. Pass when doctor isolated is true and `dataDir` is not repo `data/`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time in milliseconds for `GET /api/jobs` through the isolated Vite proxy.
- [ ] Probe. Run the GET 20 times at trunk and 20 times at the head, interleaved one trunk then one head.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail if the head median is more than 25 ms above the trunk median.

**Review gate.** None. DIR-1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends DIR-1 to the Graphite stack. The operator lands it.

## Feed direction into generate (DIR-2)

**Depends on.** DIR-1.

**Files.**

- [ ] Edit `src/server/generation.ts`.
- [ ] Edit `src/server/runs.ts`.
- [ ] Edit `src/server/app.ts`.
- [ ] Edit `tests/phase2.test.ts`.
- [ ] Edit `tests/document-quality.test.ts`.

**Build.**

- [ ] Pass `generation_direction` into `buildGenerationPrompt` as a TRUSTED section named `USER DIRECTION`.
- [ ] Map `short` to denser copy within the configured maximum. Keep the default `settings.cvPages` at 2 and `coverLetterPages` at 1.
- [ ] Map `exploratory` to adjacent-role framing that still lists `rank.gaps`. Forbid invented employers, metrics, and titles.
- [ ] Put `letterNarration` in that TRUSTED section when it is non-empty.
- [ ] Put `revisionNotes` in that TRUSTED section on regenerate and increment `revisionCount`. Do not block manual regenerate based on `revisionCount`.
- [ ] Allow regenerate from Drafting or Ready in `POST /api/jobs/:id/regenerate` and in `generateJob` when `allowDrafting` is true. Applied and later stages stay 409.
- [ ] On Ready regenerate, null `approved_at` and set stage to Drafting in the same `generateJob` write that already sets Drafting. `canTransitionStage` already allows Ready to Drafting. The HTTP gate does not.
- [ ] Do not read `jobs.notes` or `application_notes` into the prompt. Direction comes only from `generation_direction`.
- [ ] Apply `cvEdits` in `renderStructuredProfile` after template copy, under the existing `assertGrounded` rules. Drop an edit that fails grounding and keep the run if the rest compiles.
- [ ] Archive `current/` to `history/` on regenerate as today.

**You see.**

- [ ] A generate prompt for `short` contains `USER DIRECTION` and the word `short`.
- [ ] A third regenerate after two successful revises remains available and increments `revisionCount`.
- [ ] POST regenerate on a Ready job returns 202, then stage is Drafting and `approved_at` is null.
- [ ] A grounded `cvEdits` item changes the compiled CV text. An ungrounded metric in `cvEdits` does not appear in `pdftotext` output.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/phase2.test.ts` asserts prompt direction, unlimited manual regenerate, Selected-only first generate, and Ready regenerate dropping to Drafting with `approved_at` null. `tests/document-quality.test.ts` asserts grounded `cvEdits` land and ungrounded edits do not. Run `npm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Launch and doctor. Save `dir-2-launch.png`. Pass when isolated is true.
- [ ] Lane 2. Add a job on PATTERN, then Select it on SAMPLE. Save `dir-2-selected.png`. Pass when SAMPLE shows Generate documents.
- [ ] Lane 3. PUT direction `short` and `standard` via `control-job-sequencer api`. Save `dir-2-put-short.png`. Pass when GET returns `cvLength` `short`.
- [ ] Lane 4. Click Generate documents with Pi auth. Save `dir-2-generate-short.png`. Pass when stage is Drafting and CV PDF exists.
- [ ] Lane 5. Open the CV PDF link. Save `dir-2-cv-pdf.png`. Pass when `pdfinfo` page count is at most 2.
- [ ] Lane 6. Open the letter PDF. Save `dir-2-letter-pdf.png`. Pass when page count is at most 1.
- [ ] Lane 7. Approve, then POST `/api/jobs/:id/regenerate`. Save `dir-2-ready-regen.png`. Pass when stage is Drafting, `approved_at` is null, and `revisionCount` is 1.
- [ ] Lane 8. PUT a narration that names a real profile employer. Regenerate. Save `dir-2-narration.png`. Pass when `pdftotext` of the letter contains that employer.
- [ ] Lane 9. PUT `revisionNotes` that invents a metric not in the profile. Regenerate. Save `dir-2-ungrounded.png`. Pass when that metric is absent from `pdftotext`.
- [ ] Lane 10. Regenerate until `revisionCount` is 3, then once more. Save `dir-2-no-cap.png`. Pass when the later call remains allowed and the newest PDFs are published.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. End-to-end generate run duration in seconds from POST `/api/generate` 202 to run status `completed`.
- [ ] Probe. One generate of one Selected job at trunk with default direction and one at the head with complete plus standard, interleaved after a trunk baseline capture.
- [ ] Baseline. Record the trunk duration first.
- [ ] Rule. Fail if the head duration is more than 1.3 times the trunk duration.

**Review gate.** None. DIR-2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends DIR-2 to the Graphite stack. The operator lands it.

## Direct generate and revise on SAMPLE (DIR-3)

**Depends on.** DIR-2.

**Files.**

- [ ] Edit `src/tracker/sample.tsx`.
- [ ] Edit `src/tracker/order.tsx`.
- [ ] Edit `src/tracker/App.tsx`.
- [ ] Edit `tests/tracker-sample-actions.test.ts`.
- [ ] Edit `docs/GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md`.

**Build.**

- [ ] On SAMPLE for Selected, show CV length, letter stance, and narration before Generate documents. Saving direction uses `PUT /api/jobs/:id/direction`.
- [ ] On SAMPLE for Drafting, show the same controls plus a correction box and Revise. Revise writes `revisionNotes` then POST `/api/jobs/:id/regenerate`.
- [ ] Keep Revise enabled for Drafting and Ready regardless of `revisionCount`; do not show a remaining-revises counter.
- [ ] On Ready, Revise confirms then POST `/api/jobs/:id/regenerate`. The client does not write stage. DIR-2 already drops Ready to Drafting and nulls `approved_at`.
- [ ] Keep Approve as the only path to Ready. Do not auto-advance after generate or revise.
- [ ] Keep ORDER generate using the stored direction. Do not add a second direction form there.
- [ ] Update PRD §12 to name `GenerationDirection`, maximum page values, and regenerate-with-notes. Do not add a planning-approval screen.

**You see.**

- [ ] Selected SAMPLE shows CV length and letter stance before Generate documents.
- [ ] Drafting SAMPLE shows Revise without a remaining-revises counter.
- [ ] After three revises the Revise button remains enabled.
- [ ] Ready Revise returns the job to Drafting with `approved_at` null.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/tracker-sample-actions.test.ts` covers Selected direction controls, Drafting Revise without a cap disable, and Ready drop to Drafting. Run `npm test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Selected SAMPLE before generate. Save `dir-3-selected-controls.png`. Pass when CV length and letter stance are visible and Generate documents is enabled.
- [ ] Lane 2. Set short and exploratory, then generate. Save `dir-3-generate.png`. Pass when Drafting and both PDFs exist.
- [ ] Lane 3. Type a correction that asks to lead with a real profile job. Click Revise. Save `dir-3-revise.png`. Pass when `revisionCount` is 1 and Drafting holds.
- [ ] Lane 4. Open CV PDF after revise. Save `dir-3-cv-after-revise.png`. Pass when page count is at most 2.
- [ ] Lane 5. Open letter PDF after revise. Save `dir-3-letter-after-revise.png`. Pass when page count is at most 1.
- [ ] Lane 6. Approve. Save `dir-3-approved.png`. Pass when stage is Ready and Approve is gone.
- [ ] Lane 7. Revise from Ready. Save `dir-3-ready-revise.png`. Pass when stage is Drafting and `approved_at` is null.
- [ ] Lane 8. Fill the correction box with an invented metric. Revise. Save `dir-3-invented.png`. Pass when that metric is absent from letter `pdftotext`.
- [ ] Lane 9. Spend more than three revises. Save `dir-3-no-cap-ui.png`. Pass when Revise remains enabled and the newest documents are available.
- [ ] Lane 10. ORDER draft lane still generates from stored direction with no second form. Save `dir-3-order.png`. Pass when ORDER has no duplicate length control and SAMPLE still shows the stored short value.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time in milliseconds from SAMPLE load to direction controls visible.
- [ ] Probe. Cold SAMPLE open at trunk with inspector only and at the head with inspector plus direction, 10 times each, interleaved.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Fail if the head median is more than 80 ms above the trunk median.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, lane 3, and lane 9 screenshots into `artifacts/verify-job-sequencer/proof/generation-direction/dir-3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of Selected direction, generate, and revise beyond three rounds on a lane VM. Save it as `artifacts/verify-job-sequencer/proof/generation-direction/dir-3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends DIR-3 to the Graphite stack. The operator lands it after the review click.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

No prototype branch was run. Short-within-the-maximum is a product call, not a measured compile. DIR-2 lane 5 and DIR-3 lane 4 are the first proof. SAMPLE control layout is unproven until DIR-3 lane 1. A document may finish below its configured maximum; only overflow is a compile failure in Drafting.

## Appendix B. Alternatives rejected

A generate chat with file tools lost. It fights the no-tool session and the never-approve loop.
A planning screen before Generate lost. PRD §12 already made PDFs the approval point.
Allowing a shorter-than-maximum CV was retained. Compile rejects only a page maximum overflow.
Cross-job memory of corrections lost. Store direction on that application row only.
Reusing SAMPLE notes for revise lost. `PATCH /api/jobs/:id` notes stay off the generate prompt.
A second direction form on ORDER lost. One form on SAMPLE is enough.

## Appendix C. Risks

DIR-2 generate lanes fail without Pi auth. The boot recipe fails those lanes instead of faking PDFs.
Short copy that stays within the configured maximum is valid. Watch DIR-2 lane 5 for overflow.
`git show origin/main:pstack/...` may miss if pstack is not in this repo. Owners then read the plugin copies of those playbooks and record the path in the owner report.
Ready regenerate 409s today in both `app.ts` and `generateJob`. If DIR-2 skips either gate, DIR-3 lane 7 fails. Watch DIR-2 lane 7 and DIR-3 lane 7.
Ready revise can surprise if the confirm copy is weak. Watch DIR-3 lane 7.

## Appendix D. Links and reading list

Read `docs/GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md` §12 and §6 before DIR-3.
Read `src/server/generation.ts` `buildGenerationPrompt`, `generateJob`, and `renderStructuredProfile` before DIR-2. `cvEdits` is validated and unused. `generateJob` does not read job or application notes.
Read `src/server/app.ts` regenerate. It 409s unless stage is Drafting. `canTransitionStage` already lists Ready to Drafting.
Read `src/tracker/sample.tsx` `startGeneration` and `sampleStageActions` before DIR-3.
DIR-2 gets `pstack/skills/how/SKILL.md` if prompt packing is unclear. Skip interrogate unless DIR-2 grounding fails twice.
Keep the trail local per `pstack/skills/show-me-your-work/SKILL.md`. Do not commit `decisions.tsv`.

## Appendix E. Recommendations

This program is the generate loop only. Direction, revise, `cvEdits`, and Ready back to Drafting. Ship DIR-1 through DIR-3 before any item below.

Do next. These still fit the locked PRD. Each is its own later program. Do not fold them into DIR-1, DIR-2, or DIR-3.

Strip WebFetch and `cv/source/` copy steps in `loadGuidance`. `src/server/guidance.ts` currently strips YAML only. No-tool generate and interview still eat Codex tool copy. That is PRD §5.

Put named rank strengths and named rank gaps in the interview prompt. They already live on the job as `rank` from `getJobDetail`. That is packing, not a new store.

Feed `pdftotext` of the compiled CV into interview when the PDF exists. Interview currently stuffs `.tex`.

Label the SAMPLE and PHRASE notes box as follow-up only. Notes feed follow-up drafts, not the interviewer. That is PRD §15.

Require a LinkedIn ToS ack on DISK before that source can arm. Required by §5. Missing today.

Run profile import through `RunCoordinator`. Same lock, cancel, and trajectory as scrape and generate.

Refresh the Play gate after DISK saves profile or criteria. `App.tsx` loads settings once. Settings already refreshes. DISK does not.

Write the interview session pool and interview SSE into the PRD. They already shipped. Do not revert the pool as the first move.

Do later. Each needs a PRD line first. Do not start them in this stack.

An explicit Draft prep pack on Ready. Markdown under `data/applications/<id>/`. Button only. No auto-stage. No tools.

Token-aware history after a real `context_overflow` on a run. Keep `slice(-40)` until that row exists.

Coordinator concurrency above 1 for different jobs only after the global lock blocks a real search week.

Do not do these. They rebuild what PRD v1.1 removed, or they break a lock.

A vector database, embeddings, cross-job STAR memory, or a LangGraph planner.
Tools on generate or interview.
Auto-apply, auto-email, or auto-advance after a mock.
Prep on Selected.
Split mock vs debrief without amending §14.
A generate chat instead of direction plus revise.
Growing the custom-source adapter until FreeHire misses enough jobs.
