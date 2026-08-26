# Personal Job Search

Local job-search dashboard for one person. The app runs on loopback, uses Pi SDK in-process for AI workflows, and keeps provider credentials outside the project.

## Requirements

- Windows 10+
- Node.js 24.x and npm
- Bun (for the vendored job-source CLIs and their tests)
- Optional for PDF generation: `lualatex`, `xelatex`, `pdfinfo`, and `pdftotext`

Check the runtime:

```bash
node --version
npm --version
bun --version
```

## Install

From the repository root:

```bash
npm ci
```

The application uses Node/TypeScript. The vendored FreeHire, LinkedIn, and Japan board CLIs remain Bun-based.

## Configure Pi authentication

The dashboard does **not** accept or display API keys. Pi resolves credentials from its normal auth store or from environment variables.

### Option A — Pi login (recommended)

Use the local Pi CLI bundled by this project:

```bash
npx --no-install pi
```

Inside Pi, run:

```text
/login
```

Choose the provider and complete its API-key or OAuth flow. Credentials are stored in:

```text
%USERPROFILE%\.pi\agent\auth.json
```

Do not copy this file into the repository or commit it.

**ChatGPT/Codex login uses provider `openai-codex`, not `openai`.** Verify it with:

```bash
npx --no-install pi auth check --provider openai-codex --model gpt-5.6-luna
```

### Option B — environment variable

Use the variable matching the provider:

| Pi provider | Environment variable |
|---|---|
| `google` | `GEMINI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` (API key) | `OPENAI_API_KEY` |
| `openai-codex` (ChatGPT/Codex OAuth) | Use Pi `/login`; no `OPENAI_API_KEY` required |

Git Bash:

```bash
export GEMINI_API_KEY="<your-key>"
```

PowerShell:

```powershell
$env:GEMINI_API_KEY = "<your-key>"
```

Set the variable before starting the backend. Never put a real key in `data/`, `README.md`, or `data/settings.json`.

### Check provider readiness

```bash
npx --no-install pi auth check --provider google
npx --no-install pi auth check --provider anthropic
npx --no-install pi auth check --provider openai
```

Run only the check for the provider you use. Add `--model <exact-model-id>` when you want to validate a specific model. Do **not** use `--credentials` because it prints the resolved secret.

The dashboard Settings dropdown exposes `google`, `anthropic`, API-key `openai`, and `openai-codex` for ChatGPT/Codex OAuth. After selecting a provider, the Model dropdown is populated from Pi's authenticated model list. Select a model, save, then run **Test connection**.

List available model IDs when needed:

```bash
npx --no-install pi --list-models
```

## Run the application

The frontend and API run as two local processes. Build the backend first:

```bash
npm run build
```

**Terminal 1 — API server:**

```bash
npm start
```

**Terminal 2 — Vite frontend:**

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

The primary UI is Tracker, a chiptune-inspired workspace using the same local API. Open it at:

```text
http://127.0.0.1:5173/
```

Tracker is the only frontend. It exposes PATTERN (jobs), SAMPLE (job detail), ORDER (applications), PHRASE (interview), DISK (profile, criteria, and settings), and TRACE (workflow runs). `/tracker.html` remains an explicit compatibility entry for the same Tracker app; no secondary frontend route is supported.

The API is available at `http://127.0.0.1:3000`; verify it with:

```bash
curl http://127.0.0.1:3000/health
```

Vite proxies `/api` and `/health` to the backend. After changing server-side TypeScript, run `npm run build` again and restart the long-lived API process; after frontend/source-control changes, restart the long-lived Vite process too. Do not kill user-managed ports blindly. The server is loopback-only; do not expose it to the LAN.

## First-run checklist

1. Open **DISK** and enable the job sources to search (FreeHire, LinkedIn, TokyoDev, or Japan Dev). A scrape searches every checked source; each built-in source has an editable maximum age in days. FreeHire and LinkedIn default to `9999` (effectively no cutoff); TokyoDev and Japan Dev default to 45 days. Increasing a source above 45 days can return older postings and adds a warning asking you to verify that they are still active. Custom sources keep their bounded declarative HTTP(S) controls and do not require a posted-date field.
2. Select the Pi provider (`google`, `anthropic`, `openai`, or `openai-codex`).
3. Choose a model from the authenticated Model dropdown and save settings. The model field is non-secret configuration only.
4. Click **Test connection**. The credential remains in Pi auth storage/environment variables.
5. Open **DISK**, review and save the structured profile and search criteria.
6. Use **PATTERN** to scrape and review jobs. Select jobs manually before generating documents.

The canonical profile is `data/profile.json`. A legacy `data/profile.md` is preserved for review/import and is not overwritten automatically. Runtime data and generated applications are under gitignored `data/`.

## Verification commands

```bash
npm run typecheck
npm run build
npm test
npm run test:vendor:freehire
npm run smoke
npm run smoke:latex
```

Optional live source check (network-dependent, capped at five jobs):

```bash
npm run live:scrape
```

Browser workflow check:

```bash
npm run smoke:browser
npm run smoke:browser:tracker
```

`smoke:browser` starts fixture API/frontend processes, opens the root Tracker, exercises PATTERN/ORDER/PHRASE/SAMPLE/DISK/TRACE, and checks zero console/page/request errors plus desktop/mobile overflow. `smoke:browser:tracker` remains an explicit alias for existing gate commands.

`smoke:latex` uses temporary files and fixed executable argument arrays. It exits non-zero when a compiler or PDF verifier is unavailable.

## Workflow and safety boundaries

- Profile facts are serialized deterministically for each provider workflow.
- Pi sessions disable ambient skills, extensions, prompt templates, themes, context discovery, and unrestricted built-in tools where the workflow requires it.
- Scraping exposes only typed `searchJobs` and `fetchJobDetails` wrappers. Built-in sources use their vendored CLIs; custom sources use bounded HTTP(S) URL templates and data-only JSON paths or simple HTML selectors. No arbitrary commands or user code are accepted.
- Every workflow is manual: scraping does not automatically select jobs, generate documents, apply, start interview practice, or send follow-ups.
- Document generation stops at `Drafting`; explicit approval is required for `Ready`, and explicit manual recording is required for `Applied`.
- There is no user authentication, CORS, cloud sync, job submission, email sending, or automatic provider fallback.
- Keep credentials in Pi auth storage or environment variables. Never commit `auth.json`, `.env` files, API keys, tokens, or generated personal data.
