# PATTERN jobs

PATTERN is the job inbox. On a fresh isolated launch it is empty. ADD JOB opens a dialog that validates empty input and can be cancelled without creating a row.

## Sub-features

- `pattern-empty` shows the empty inbox copy.
- `pattern-filters` lists All / Recommended / … chips without changing data.
- `pattern-add-open` opens the manual add dialog from `ADD JOB`.
- `pattern-add-validate` rejects empty submit with an alert.
- `pattern-add-cancel` closes the dialog with Cancel or Escape and leaves the table empty.
- `pattern-add-live` (Pi) pastes a posting and waits for a new row — skip unless Pi auth is confirmed.

## How to get to it (user POV)

- Choose `PATTERN` or `00 SCRAPE` / `01 RANK`.
- Open `#/pattern`.
- Choose `ADD JOB` on the PATTERN header.
- Type `/import <url or posting>` in the footer (same import pipeline; prove the dialog unless testing the slash command).

## Driving it with control-job-sequencer

Preconditions:

- Isolated instance is healthy.
- No jobs in the inbox.

- **Empty inbox.** Open PATTERN. Run `browser goto --hash "#/pattern"` then `browser wait --text "Pattern is empty"`. Header still shows `ADD JOB`. Body explains scrape after DISK is ready.
- **Open dialog.** Choose `ADD JOB`. Run `browser click --role button --name "ADD JOB" --exact`. Dialog named `Add job manually` appears with textbox `Job URL or pasted posting`.
- **Empty validation.** Submit with no text. Run `browser click --role button --name "Add job" --exact`. An `alert` contains `Enter a posting URL or paste job text.` Dialog stays open.
- **Cancel.** Dismiss without adding. Run `browser press --key Escape`. Dialog is hidden. PATTERN still shows `Pattern is empty`.
- **Live import (skip without Pi).** Paste a public HTTPS job URL only when `doctor` plus Pi auth are confirmed, then `browser fill --label "Job URL or pasted posting" --value "<url>"` and `browser click --role button --name "Add job" --exact`. Wait for a PATTERN row with the imported company. Timeout 30s. If Pi is missing, record skip; do not POST `/api/jobs/manual` outside the UI.
- **Proof.** Capture the empty inbox after cancel. Run `browser snapshot --path pattern-jobs/empty.aria.txt` and `browser screenshot --path pattern-jobs/empty.png`. Artifacts show TRACKER, `PATTERN 00`, and `Pattern is empty`.

## Gotchas

- `Add job` (dialog submit) is not `ADD JOB` (opener). Use `--exact`.
- Manual import starts a run and toasts `Manual import started.` The row appears after the run finishes; wait for the company text, not a fixed sleep.
- Private/local URLs are rejected by the server. Use a public HTTPS URL or pasted posting text.
- Clicking a PATTERN row navigates to SAMPLE for that job id.
