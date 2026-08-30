# Tracker shell

Tracker shell is the chiptune workspace chrome: transport, Editor tabs, and hash routes that switch PATTERN, ORDER, PHRASE, SAMPLE, DISK, and TRACE without leaving the page.

## Sub-features

- `shell-load` opens Tracker at the root and lands on PATTERN.
- `shell-editor-tabs` switches every Editor tab from the `Editor` navigation.
- `shell-hashes` opens the same views through hash URLs.
- `shell-empty-sample` shows SAMPLE's no-row state when no job is selected.
- `shell-song-chain` highlights SCRAPE/RANK/DOCS/APPLY/PHRASE without starting a Pi run.

## How to get to it (user POV)

- Open the isolated frontend root `/` (hash becomes `#/pattern`).
- Choose `PATTERN`, `ORDER`, `PHRASE`, `SAMPLE`, `DISK`, or `TRACE` in the Editor nav.
- Paste or goto `#/pattern`, `#/order`, `#/phrase`, `#/sample`, `#/disk`, `#/trace`.
- Choose `00 SCRAPE`, `01 RANK`, `03 DOCS`, `04 APPLY`, or `05 PHRASE` in the Song chain.

## Driving it with control-job-sequencer

Preconditions:

- Isolated instance is healthy (`doctor` reports `TRACKER - Job Sequencer`).
- Inbox is empty (fresh launch).

- **Root load.** Open PATTERN. Run `browser goto --hash "#/pattern"`. Title is `TRACKER - Job Sequencer` and text `PATTERN 00` is visible. Empty copy includes `Pattern is empty`.
- **ORDER tab.** Choose ORDER. Run `browser click --role link --name ORDER --exact`. Text `ORDER LIST` is visible.
- **PHRASE tab.** Choose PHRASE. Run `browser click --role link --name PHRASE --exact`. Text `ELIGIBLE` is visible.
- **SAMPLE empty.** Choose SAMPLE. Run `browser click --role link --name SAMPLE --exact`. Text `Open a row from PATTERN to inspect a sample.` is visible.
- **DISK tab.** Choose DISK. Run `browser click --role link --name DISK --exact`. Text `DISK · SAMPLE BANK` is visible.
- **TRACE tab.** Choose TRACE. Run `browser click --role link --name TRACE --exact`. Text `No runs yet.` is visible.
- **Hash entry.** Open ORDER by URL. Run `browser goto --hash "#/order"`. `ORDER LIST` is visible without using the tab click.
- **Song chain DOCS.** Choose `03 DOCS`. Run `browser click --role button --name "03 DOCS" --exact`. ORDER opens focused on draft (`DOCS · posisi B00–B01`).
- **Proof.** Capture TRACE empty history. Run `browser snapshot --path tracker-shell/trace.aria.txt` and `browser screenshot --path tracker-shell/trace.png`. Artifacts show TRACKER and `No runs yet.`

## Gotchas

- `/tracker.html` is a compatibility entry for the same app. Prove `/` unless a bug is specific to `/tracker.html`.
- SAMPLE without a job id never shows `.sample-panel`; wait for the empty copy instead.
- `00 SCRAPE` arms a scrape confirm in the agent panel; it does not start a network scrape until the user confirms. Do not confirm unless the feature under test is scrape.
- Hash `#/sample/<id>` on an unknown id shows a load/error empty state, not the PATTERN table.
