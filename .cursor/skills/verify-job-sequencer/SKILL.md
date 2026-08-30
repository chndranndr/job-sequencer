---
name: verify-job-sequencer
description: Drive the Job Sequencer Tracker web UI the way a user does — isolated launch, doctor, Playwright control helper, proof artifacts. Use when proving PATTERN, ORDER, PHRASE, SAMPLE, DISK, or TRACE behavior.
---

# Verify Job Sequencer

Job Sequencer is a loopback-only Tracker dashboard. The user-facing surface is the Vite React app at an isolated `http://127.0.0.1:<ephemeral>/` (hash routes). The Fastify API is proxied through `/api` and `/health`. There is no login. Do not drive the operator's long-lived `npm start` (port 3000) or `npm run dev` (port 5173), and never write the shared `data/` directory.

Secondary surfaces (do not use them as the primary proof path): HTTP `/health` and `/api/*` through the Vite proxy; vendored Bun job-source CLIs; `npm test` / `npm run smoke:browser` as regression gates, not as the user path.

## Launch

From the repository root, after `npm ci` (Node 24.x). Playwright Chromium must be available (`npx playwright install chromium` if the first launch fails on a missing browser).

```bash
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts launch
```

Ready when the command prints JSON with `doctor.title` `TRACKER - Job Sequencer`, `isolated: true`, and a `frontendUrl` that is not port 5173. The helper starts:

- a disposable data directory under the OS temp dir (`job-sequencer-verify-*`)
- Fastify via `buildServer` on an ephemeral loopback port
- Vite with `API_PORT` pointed at that API, `--strictPort`, ephemeral loopback port
- one headless Chromium page already on `#/pattern`

Teardown (never `taskkill` by image name; only PIDs this run stored):

```bash
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts cleanup
```

Cleanup deletes the temp data dir and stops the serve/Vite PIDs. It does **not** delete `artifacts/verify-job-sequencer/proof/`.

If `launch` is run while a previous verification instance is still up, it shuts that instance down first.

## Doctor

Run this first whenever anything looks off:

```bash
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts doctor
```

It is worth driving only when all of these hold:

- `artifacts/verify-job-sequencer/run-state.json` exists and its `servePid` is alive
- `GET {apiUrl}/health` returns `{"ok":true,"service":"job-sequencer"}`
- Vite `GET {frontendUrl}/health` proxies the same payload
- `GET {frontendUrl}/` is 200 and the page title is `TRACKER - Job Sequencer`
- `dataDir` is **not** the repo `data/` folder
- `frontendUrl` is **not** `http://127.0.0.1:5173` paired with API port 3000

Refuse to continue if doctor fails. Do not fall back to the user's session.

## Drive

Helper (from repo root). Treat every flag value as literal.

```bash
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts browser goto --hash "#/pattern"
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts browser click --role link --name PATTERN --exact
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts browser click --role button --name "ADD JOB" --exact
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts browser fill --label "First name" --value "Ada"
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts browser press --key Escape
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts browser wait --text "PATTERN 00"
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts api --method GET --path /api/profile
```

Stable handles:

| User target | Handle |
|---|---|
| Root Tracker | title `TRACKER - Job Sequencer`, landmark `.studio`, heading text `TRACKER` |
| Editor tabs | `navigation` named `Editor`; links `PATTERN`, `ORDER`, `PHRASE`, `SAMPLE`, `DISK`, `TRACE` |
| Song chain | `navigation` named `Song chain`; buttons `00 SCRAPE`, `01 RANK`, `03 DOCS`, `04 APPLY`, `05 PHRASE` |
| PATTERN | text `PATTERN 00`; table named `Job pattern: SIG keyword signal, FIT score, AGE inbox days, FX workflow stage, SRC job source`; button `ADD JOB` |
| Manual add | `dialog` named `Add job manually`; textbox `Job URL or pasted posting`; buttons `Add job`, `Cancel` |
| ORDER | text `ORDER LIST`; list named `Song order list` |
| PHRASE | text `ELIGIBLE`; search named `Filter eligible PHRASE jobs` |
| SAMPLE (no row) | text `Open a row from PATTERN to inspect a sample.` |
| DISK | text `DISK · SAMPLE BANK`; `navigation` named `Profile banks`; buttons `A·ID`, `B·WORK`, `C·EXTRA`, `D·CRIT`; resume import on `A·ID`; fields `First name`, `Professional headline`; buttons `Write to disk` / `Synced`; sidebar `DISK fine-tune sidebar`; `Write settings`, `Test link` |
| TRACE | text `TRACE 06 · RUN HISTORY` or `No runs yet.` |
| Toast | `status` role (e.g. `Profile written to disk.`). Toasts last ~2.8s; assert lasting UI (`Synced`, field values) unless you wait in the same breath as the click. |
| Hash routes | `#/pattern`, `#/order`, `#/order/draft`, `#/order/ready`, `#/order/follow`, `#/phrase`, `#/sample/<jobId>`, `#/disk`, `#/trace` |

Read the feature map under `features/` before proving a behavior. Drive the mapped entry points, not a convenient substitute.

Live scrape, document generation, interview practice, and `Test link` need Pi credentials in `%USERPROFILE%\.pi\agent\auth.json` (or provider env vars). Isolated launch does not copy the user's `data/`. Skip those sub-features unless doctor-plus-auth is explicit in the feature file; still prove the UI gate and empty states.

## Evidence

Write proof under `artifacts/verify-job-sequencer/proof/<feature-id>/`. Named location after cleanup: that directory still exists.

```bash
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts browser snapshot --path disk-profile/after-save.aria.txt
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts browser screenshot --path disk-profile/after-save.png
```

Proof standards:

- Exercise the real Tracker controls and hash routes. Do not write `data/profile.json` or SQLite by hand to fake a result.
- Capture the action (click/fill) and the resulting state (toast, reloaded fields, ARIA snapshot, screenshot with `TRACKER` visible).
- For mutations, confirm persistence from a second user-facing view: reload `#/disk` or `GET /api/profile` through the Vite proxy (`control-job-sequencer api`).
- Do not call test-only endpoints. The smoke script `scripts/browser-smoke-tracker.ts` is a gate, not a user path.
- Mocks belong only at production boundaries (Pi providers, remote job boards). Empty isolated data is the default; do not invent jobs in the DB.
- `/scrape`, `/generate`, and `Test link` may still hit the network when Pi is configured. Observe files, `TRACE` runs, and HTTP before calling a path safe.

## Cleanup

```bash
npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts cleanup
```

Kills the serve PID and Vite child recorded in `run-state.json`, removes the temp data dir, removes `run-state.json`. Leaves `artifacts/verify-job-sequencer/proof/` and `serve.log` (if present). After a failed iteration, run cleanup before the next launch so ports and Chromium do not leak.

## Helpers

`npx --no-install tsx .cursor/skills/verify-job-sequencer/bin/control-job-sequencer.ts help` prints the command list. `launch`, `doctor`, `browser *`, `api`, and `cleanup` are the only supported entry points. `serve` is internal (spawned by `launch`).
