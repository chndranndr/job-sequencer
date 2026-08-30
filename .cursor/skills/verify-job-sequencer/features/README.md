# Job Sequencer verification map

This directory is the maintained source for verifying user-facing Tracker behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts launch`.
- Run `doctor` and require `TRACKER - Job Sequencer`, `isolated: true`, and a temp `dataDir`.
- Never drive `http://127.0.0.1:5173` or the repo `data/` folder.
- Start from an empty isolated inbox unless a feature file seeds through the UI.
- Prefer ARIA roles, accessible names, and hash routes over CSS position.
- Treat helper flags as literal.
- Cleanup after the run. Keep `artifacts/verify-job-sequencer/proof/`.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Navigate with Editor links or `browser goto --hash`.
- Restore isolated state by cleaning up and launching again after mutations you do not need to keep.
- Report an unreachable path with the command used and the unmet precondition. Do not call a skipped Pi-backed path verified via a stub.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with TRACKER visible.
- Mutation proof includes a reload or `api GET` of the saved value.
- Record the feature ID and entry point with every artifact.
- Live scrape, generate, interview, and Test link need Pi auth. Skip those sub-features unless auth is confirmed; still prove gates and empty states.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with control-job-sequencer`
4. `Gotchas`

## Features

- [Tracker shell](./tracker-shell.md) covers Editor tabs PATTERN, ORDER, PHRASE, SAMPLE, DISK, TRACE on an empty inbox.
- [DISK profile](./disk-profile.md) covers writing identity to disk and confirming it after reload.
- [PATTERN jobs](./pattern-jobs.md) covers the empty inbox, ADD JOB validation, and cancel.
- [ORDER applications](./order-applications.md) covers the application board and empty stage slots.
- [PHRASE interview](./phrase-interview.md) covers the empty eligible list before any Applied job exists.
