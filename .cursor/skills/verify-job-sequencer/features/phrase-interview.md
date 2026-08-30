# PHRASE interview

PHRASE is interview practice for jobs already marked Applied or Interview. On a fresh isolated launch the eligible list is empty and practice does not start.

## Sub-features

- `phrase-open` opens PHRASE from the Editor tab, `05 PHRASE`, `#/phrase`, and `/interview`.
- `phrase-empty` shows the empty eligible copy.
- `phrase-filters` exposes SEARCH and STAGE (Applied + Interview).
- `phrase-live` (Pi) runs practice on an eligible job — skip unless an Applied job exists and Pi auth is confirmed.

## How to get to it (user POV)

- Choose `PHRASE` in the Editor nav.
- Choose `05 PHRASE` in the Song chain.
- Open `#/phrase`.
- Type `/interview` in the footer composer.

## Driving it with control-job-sequencer

Preconditions:

- Isolated instance is healthy.
- No Applied or Interview jobs.

- **Open PHRASE.** Choose PHRASE. Run `browser goto --hash "#/phrase"` then `browser wait --text "ELIGIBLE"`. Search named `Filter eligible PHRASE jobs` is visible.
- **Empty eligible.** Read the list. Text `Applied and Interview jobs appear here after you mark Applied on SAMPLE.` is visible. Workspace copy `Pick an eligible job to practice.` is visible.
- **Stage filter still empty.** Change STAGE if needed; empty copy remains until a job is marked Applied on SAMPLE.
- **Proof.** Capture the empty PHRASE view. Run `browser snapshot --path phrase-interview/empty.aria.txt` and `browser screenshot --path phrase-interview/empty.png`. Artifacts show TRACKER, `ELIGIBLE`, and the Applied-gate copy.

## Gotchas

- Practice does not change job stage. Eligibility still requires Applied or Interview first (SAMPLE `Mark Applied`).
- Unsaved interview notes prompt before navigation. Stay on PHRASE or confirm leave if that dialog appears.
- Starting practice hits Pi. Do not click send on the answer box unless proving `phrase-live` with auth.
