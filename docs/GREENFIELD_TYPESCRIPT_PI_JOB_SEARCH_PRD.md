# Job Sequencer — PRD v1.2

## 1. Summary

A local dashboard for one person with this workflow:

```text
START
  ↓
User fills Profile + Search Criteria
  ↓
User clicks Scrape Jobs
  ↓
Pi searches jobs and scores each job against the profile
  ↓
score > 60?
  ├── NO  → Discarded
  └── YES → Recommended
                 ↓
          User selects interesting jobs
                 ↓
          User clicks Generate CV & Cover Letter
                 ↓
          Pi generates documents
                 ↓
          Human reviews and approves
                 ↓
          Human applies manually outside the app
                 ↓
          Human changes status to Applied
                 ↓
          User opens Interview and practices in chat
                 ↓
          Pi drafts a follow-up when requested
                 ↓
          Human sends the follow-up manually
```

The workflow is **not continuous**. Every box after Scrape Jobs requires a separate user action. Pi must never continue automatically from scraping to generating documents, applying, interview practice, or follow-up.

The app is built from scratch in TypeScript and uses Pi SDK directly. It has no dependency on the existing Python backend, Codex CLI, or Codex app-server.

This is a personal tool on a trusted computer, not a SaaS product.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| User model | One local user |
| Runtime | Node.js 24 + TypeScript |
| Vendored CLI runtime | Existing Bun runtime; do not port the CLIs to Node |
| Backend | Fastify |
| Frontend | React + Vite |
| Database | Built-in `node:sqlite` if Phase 0 passes; otherwise `better-sqlite3` |
| Validation | Zod |
| AI runtime | `@earendil-works/pi-coding-agent` in-process |
| Package layout | One package |
| Deployment | `127.0.0.1` only |
| Ranking threshold | Strictly `score > 60` passes; `score <= 60` is Discarded |
| Provider selection | One active provider/model; user switches manually |
| Submission | Always performed manually by the user |
| Progress updates | Polling, not SSE/WebSocket |
| Existing skills | Reuse the repository's `vendor/ai-job-search-skills` CLIs and reference files |

## 3. Goals

The app should let the user:

1. enter a reusable profile;
2. enter job-search criteria;
3. ask Pi to find and rank relevant jobs;
4. hide low-fit jobs without deleting them;
5. choose interesting jobs manually;
6. generate and verify a CV and cover letter;
7. approve the documents before use;
8. record that an application was submitted manually;
9. practice an interview in chat using the exact job and application documents;
10. draft a follow-up message and send it manually.

## 4. Non-goals

MVP will not include:

- automatic progression between workflow steps;
- automatic job application submission;
- automatic follow-up sending;
- automatic stage changes after ranking, mock interview, or follow-up drafting;
- user accounts, login, RBAC, billing, or tenancy;
- cloud hosting or cloud sync;
- Codex compatibility;
- automatic provider fallback;
- generic approval, audit, policy, plugin, or connector frameworks;
- arbitrary Pi shell, filesystem, browser, or unrestricted network tools;
- vector database or RAG;
- event sourcing;
- cost telemetry dashboard;
- fuzzy duplicate merging;
- desktop or mobile packaging.

Add deferred features only after personal use proves they are needed.

## 5. Reuse existing skills

Do not reimplement the existing search CLIs, scoring guidance, writing rules, CV guidance, or interview material.

During Phase 0, copy this directory into the new repository:

```text
vendor/ai-job-search-skills
  → vendor/ai-job-search-skills
```

Copy all ten skill directories, excluding generated dependency/build folders such as `node_modules`, `dist`, and coverage output:

```text
freehire-search
japan-boards-search
job-application-assistant
job-scraper
jobbank-search
jobdanmark-search
jobindex-search
jobnet-search
linkedin-search
upskill
```

The copied directory is self-contained. The new app must not read skill files from the old repository at runtime.

### Runtime reuse map

| Product feature | Reuse |
|---|---|
| Selectable job search | Enabled checkboxes route `freehire-search/cli`, `linkedin-search/cli`, or `japan-boards-search/cli`; bounded custom HTTP(S) sources are also supported |
| Optional Denmark search | Existing Denmark CLIs; dormant by default |
| Search-query strategy | `job-scraper/search-queries.md` |
| Fit scoring guidance | `job-application-assistant/04-job-evaluation.md` |
| CV writing guidance | `job-application-assistant/03-writing-style.md` and `05-cv-templates.md` |
| Cover-letter guidance | `job-application-assistant/03-writing-style.md` and `06-cover-letter-templates.md` |
| Interview chat guidance | `job-application-assistant/07-interview-prep.md` |
| Profile bootstrap/reference | `job-application-assistant/01-candidate-profile.md` and `02-behavioral-profile.md`; dashboard `data/profile.json` is canonical runtime truth and `data/profile.md` is preserved legacy backup/import source |

### Integration rules

- Preserve each copied skill's license/provenance and existing tests.
- Do not port portal parsers into the application.
- Search tools call the copied CLIs through `bun` with fixed argument arrays and JSON output.
- Do not expose a generic command string to Pi.
- Validate CLI JSON before returning it to Pi.
- The application's typed `searchJobs` and `fetchJobDetails` tools wrap the CLIs; Pi never invokes the CLI process directly.
- Read only the explicitly mapped Markdown files when building prompts.
- Do not pass `SKILL.md` frontmatter, `allowed-tools`, Codex instructions, or old file-write workflow instructions into Pi prompts.
- `data/profile.json` and dashboard criteria override personalized profile/query text inside the copied skills. The legacy `data/profile.md` is never edited by the dashboard.
- Reuse the dimensions and weighting from `04-job-evaluation.md`, but the product rule in `settings.json` wins over its legacy labels: only a score strictly greater than 60 is Recommended.
- Pi ambient extension/skill/context discovery remains disabled.
- Run each activated CLI's existing tests unchanged before declaring the integration working.

```typescript
// ponytail: vendored CLIs are the implementation; wrappers only validate args,
// spawn bun, parse JSON, and normalize the existing output.
```

## 6. Manual workflow boundaries

Each action stops when its stated output is ready.

| User action | Pi/backend does | Stops at |
|---|---|---|
| Save Profile | Validates and stores profile | Saved profile |
| Save Criteria | Validates and stores criteria | Saved criteria |
| Scrape Jobs | Searches, fetches details, scores, stores results | Recommended/Discarded list |
| Select job | Marks job Selected | Selected job |
| Generate documents | Drafts, writes, compiles, verifies. Reads `GenerationDirection` from that application row. See §12. | Documents awaiting approval |
| Revise documents | Regenerates from stored direction and `revisionNotes`. See §12. | Documents awaiting approval |
| Approve documents | Marks documents Ready | Ready job |
| Record Applied | Stores submission data | Applied job |
| Start mock interview | Runs chat practice | Chat session only |
| Draft follow-up | Generates editable message | Draft text only |
| Mark follow-up sent | Stores sent timestamp | Updated application |

No action calls the next action internally.

## 7. Navigation

MVP navigation:

- Jobs
- Applications
- Interview
- Profile & Criteria
- Settings

No admin area is needed.

## 8. Profile and criteria

### Profile

The dashboard provides a structured editor backed by:

```text
data/profile.json
```

The profile should include:

- name and contact details;
- location;
- work authorization and relocation preference;
- professional experience;
- education;
- skills;
- certifications;
- projects and awards;
- languages;
- target roles;
- deal-breakers.

The user owns the truth of this file. Pi may help format it, but Pi must not silently add unverified experience or skills. If `profile.md` exists without `profile.json`, the dashboard preserves it unchanged and presents a one-time review/import view; it never infers or silently migrates facts.

### Search criteria

Store criteria in:

```text
data/criteria.json
```

Minimal shape:

```json
{
  "roles": ["Senior Backend Engineer", "Senior Full Stack Engineer"],
  "locations": ["Remote", "Indonesia", "APAC"],
  "remoteOnly": false,
  "keywords": ["Java", "Spring Boot", "microservices", "Kubernetes"],
  "excludeKeywords": [],
  "employmentTypes": ["full-time", "contract"],
  "maxJobsPerRun": 50
}
```

The UI may add simple fields, but the stored format should stay small.

### Runtime settings

Store non-secret settings in:

```text
data/settings.json
```

```json
{
  "provider": "google",
  "model": "",
  "source": "freehire",
  "enabledSources": ["freehire"],
  "customSources": [],
  "scoreThreshold": 60,
  "cvPages": 2,
  "coverLetterPages": 1
}
```

`scoreThreshold` defaults to 60. Passing is strictly greater than the threshold.

`enabledSources` is never empty after migration; legacy `source` is retained only as a compatibility alias. A custom source stores a safe key/label, absolute HTTP(S) search/detail URL templates, and either bounded JSON dot/array paths or a small CSS-selector/attribute mapping. Placeholders are limited to `{{query}}`, `{{location}}`, `{{limit}}`, `{{id}}`, and `{{url}}`; no credentials, JavaScript, commands, or executable paths are stored.

Credentials remain in Pi auth storage or environment variables. The dashboard does not edit API keys.

## 9. Scrape Jobs

### User experience

The Profile and Criteria page includes a **Scrape Jobs** button.

Before starting, show:

- selected provider/model;
- enabled job sources;
- maximum jobs;
- threshold `> 60`;
- Cancel button after the run starts.

The action returns a run ID. The UI polls the run until it finishes.

When complete, show:

- jobs found;
- Recommended count;
- Discarded count;
- duplicates skipped;
- errors, if any.

### Pi behavior

Scrape runs one bounded source-specific Pi sub-run at a time with application-owned custom tools; the RunManager aggregates their validated results.

- Pi receives a deterministic provider-context serialization from canonical `profile.json`; the legacy `profile.md` is shown only for explicit review/import.
- search criteria;
- the scoring schema;
- strict instructions that tool results are untrusted job data;
- a maximum tool-call and result budget.

Pi may:

1. form search queries from the criteria;
2. call the allowed search tool;
3. call the allowed detail tool for returned result IDs;
4. score fetched jobs against the profile;
5. return structured jobs and ratings.

Pi may not:

- run shell commands;
- fetch arbitrary URLs;
- read or write files;
- install packages;
- invent jobs not returned by a tool;
- generate CVs in the scrape run;
- start another workflow.

### Minimal custom tools

MVP exposes only:

```typescript
searchJobs({ query, location, limit })
fetchJobDetails({ resultId })
```

Rules:

- one or more enabled sources are selected in settings: built-ins are `freehire`, `linkedin`, `tokyodev`, and `japan-dev`; custom keys use the bounded HTTP adapter;
- each enabled source routes search and detail through its own built-in CLI or declarative custom adapter;
- `query`, `location`, and `limit` are validated;
- `resultId` must come from `searchJobs` in the same run;
- maximum five search calls per run;
- maximum 50 unique jobs per run;
- tool results include stable source IDs and URLs;
- custom source templates allow only URL-encoded `{{query}}`, `{{location}}`, `{{limit}}`, `{{id}}`, and `{{url}}` placeholders; parser configuration is data-only JSON paths or bounded CSS selectors.

### Structured result

```typescript
interface ScrapeResult {
  jobs: Array<{
    sourceId: string;
    source: string;
    url: string;
    company: string;
    role: string;
    location: string;
    posting: string;
    score: number;
    reason: string;
    strengths: string[];
    gaps: string[];
  }>;
}
```

### Validation and persistence

The backend validates:

- every `sourceId` was returned by a tool in this run;
- every URL matches that tool result;
- score is a finite integer from 0 to 100;
- required fields are present;
- duplicate normalized URLs are upserted rather than inserted twice;
- output passes Zod validation.

For new jobs:

```text
score > threshold  → Recommended
score <= threshold → Discarded
```

Discarded means hidden by default, not deleted.

For existing jobs:

- update posting, score, and ranking explanation;
- preserve Selected, Drafting, Ready, Applied, Interview, Offer, and Rejected stages;
- Recommended and Discarded may be recalculated.

If the final AI JSON is invalid, attempt one same-provider repair. This applies to scrape, generate, profile import, and manual job parse. Extract a JSON object from mixed model text before schema validation. If the repair is still invalid, persist nothing from that run.

## 10. Jobs dashboard

### All jobs table

Always show the full table:

| Column | Behavior |
|---|---|
| Company / role | Opens job detail |
| Location | Plain text |
| Stage | Current stage |
| Score | Number or `Not scored` |
| Source | Job source |
| First seen | Local date |

Fit and stage filters change rows, not columns.

Default view:

- Recommended;
- Selected;
- Drafting;
- Ready;
- Applied;
- Interview;
- Offer.

Discarded is available through a filter.

### Job detail

Show:

- title, company, location, URL, source;
- complete posting text;
- score and ranking reason;
- strengths and gaps;
- current stage;
- notes;
- generated CV and cover-letter links;
- approval/submission/interview/follow-up fields.

### Selection

The user selects jobs with a checkbox or **Select** action.

```text
Recommended → Selected
Selected → Recommended   when unselected
```

Selection is always manual. A score above 60 does not select a job automatically.

Multiple jobs may be Selected. Document generation processes selected jobs one at a time.

## 11. Stages

Use these stages:

```text
Recommended
Discarded
Selected
Drafting
Ready
Applied
Interview
Offer
Rejected
Archived
```

Rules:

- Scrape assigns only Recommended or Discarded for new jobs.
- User selection assigns Selected.
- Generate documents assigns Drafting.
- Successful verification does not assign Ready by itself.
- Human approval assigns Ready.
- Human Record Applied action assigns Applied.
- Starting a mock interview does not change stage.
- User changes Applied to Interview when a real interview is scheduled.
- Drafting follow-up does not change stage.
- Rejected and Archived are manual.
- One shared function validates these rules; no generic state-machine library is needed.

## 12. Generate CV and cover letter

### User action

The Jobs page includes **Generate CV & Cover Letter** for selected jobs.

SAMPLE collects `GenerationDirection` before generate. CV length is `short` or `complete`. Letter stance is `standard` or `exploratory`. Narration is optional. The configured CV and cover-letter page values are maximums, so generated documents may be shorter; `short` still means denser copy within the configured CV page maximum, which defaults to two pages. ORDER Accept · generate uses the stored direction. It does not show a second length or stance form.

Revise writes `revisionNotes` then POSTs regenerate. Manual revises have no fixed cap. Ready revise returns the job to Drafting. Keep only the three most recent prior document versions in history. Approve remains the only path to Ready.

For multiple selected jobs, process them sequentially. Each job has its own success or failure result.

### Templates

The user places verified templates in:

```text
templates/
  cv/
    backend.tex
    full-stack.tex
  cover-letter.tex
  cover.cls
  fonts/
  templates.json
```

Minimal metadata:

```json
{
  "cv": {
    "backend": {
      "file": "templates/cv/backend.tex",
      "tags": ["java", "backend", "platform"]
    },
    "full-stack": {
      "file": "templates/cv/full-stack.tex",
      "tags": ["react", "typescript", "full-stack"]
    }
  },
  "coverLetter": "templates/cover-letter.tex"
}
```

### Generation flow

1. Backend sets job to Drafting.
2. Pi receives profile, posting, score explanation, and template metadata.
3. Pi proposes:
   - template;
   - role-specific emphasis;
   - genuine gaps;
   - CV edits;
   - cover-letter content.
4. Pi returns structured content with no tools.
5. Backend validates output. Invalid JSON or failed business validation is sent back to the same provider once with the validator error. A second failure fails the run and persists nothing.
6. Backend copies the chosen CV template into the job directory.
7. Backend applies supported replacements.
8. Backend writes cover-letter source.
9. Backend compiles and verifies both PDFs.
10. UI displays source, PDFs, and verification result.
11. Workflow stops and waits for human approval.

There is no separate planning approval screen in MVP. The final source and PDFs are the approval point.

### Truthfulness

- Pi must use only information in the canonical structured `profile.json` and stored job/fit data.
- Pi must acknowledge genuine gaps instead of inventing support.
- Experience bullets on the compiled CV come from that role's profile description. A `cvEdits` line attaches only to the matching employer. Planning instructions in model JSON are invalid output, not CV text.
- The user reviews final documents before approval.
- A profile-fact database is not required for MVP.

### Files

```text
data/applications/<job-id>/
  current/
    cv.tex
    cv.pdf
    cover-letter.tex
    cover-letter.pdf
    verification.json
  history/
    <timestamp>/
```

Before replacing `current/`, move the previous version into `history/` and retain only the three most recent history directories.

### Compilation and verification

Use argument arrays and timeouts:

```text
lualatex  → CV
xelatex   → cover letter
pdfinfo   → page count
pdftotext → ATS text extraction
```

Required checks:

- compiler exits successfully;
- expected PDF exists;
- CV does not exceed the configured CV page maximum (two pages by default);
- cover letter does not exceed the configured cover-letter page maximum (one page by default);
- extracted text is non-empty;
- email and phone are present as literal text;
- generated paths remain inside the job application directory.

Any failure keeps the job in Drafting.

## 13. Human approval and manual application

### Approval

After reviewing the source and PDFs, the user chooses:

- **Approve** → stage becomes Ready;
- **Regenerate** → stage remains Drafting and a new version is created;
- **Reject draft** → stage remains Drafting.

No approval table is needed. Store `approved_at` on the application row.

### Manual application

The user clicks **Open job posting** and applies outside the app.

After submission, the user clicks **Mark as Applied** and may enter:

- submitted date;
- channel/portal;
- notes.

Only this explicit action changes Ready to Applied.

The app never claims it submitted the application.

## 14. Interview practice

### Interview menu

The Interview menu lists Applied and Interview jobs.

The user picks a job and opens a chat.

### Chat context

Each message may include:

- profile;
- stored job posting;
- score strengths and gaps;
- exact generated CV;
- exact generated cover letter;
- recent mock-interview messages;
- optional focus entered by the user.

### Chat behavior

Pi acts as an interviewer:

- asks one question at a time;
- waits for the user's answer;
- gives concise feedback;
- asks a follow-up question when useful;
- points out unsupported or weak claims;
- helps improve truthful STAR-style answers;
- does not claim knowledge outside supplied context.

Each chat message uses a new no-tool Pi session with bounded recent history. No persistent Pi session is required.

Store the latest chat as JSON in the application row. Keep at most 40 messages. The user may reset the chat.

Starting or completing practice does not change the job stage.

### Chat API shape

```typescript
interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
```

## 15. Follow-up

Follow-up is user-triggered and manually sent.

For an Applied or Interview job, the user may:

1. enter context such as interview date, interviewer name, or purpose;
2. click **Draft Follow-up**;
3. review and edit Pi's draft;
4. copy/send it outside the app;
5. click **Mark sent**.

Pi receives:

- profile name;
- company and role;
- application stage;
- relevant interview notes entered by the user;
- requested tone/purpose.

Pi runs with no tools.

Store:

- follow-up draft;
- optional due date;
- sent timestamp.

The dashboard may show due follow-ups. No background email, notification service, or scheduler is needed.

## 16. Pi SDK integration

### Session types

| Workflow | Built-in tools | Custom tools |
|---|---|---|
| Scrape + rank | Disabled | `searchJobs`, `fetchJobDetails` |
| Generate documents | Disabled | None |
| Profile import | Disabled | None |
| Manual job parse | Disabled | None |
| Interview chat | Disabled | None |
| Follow-up draft | Disabled | None |
| Test connection | Disabled | None |

### Resource policy

Every Pi session disables:

- extensions discovery;
- skills discovery;
- prompt-template discovery;
- theme discovery;
- context-file discovery;
- third-party Pi packages.

Conceptual loader:

```typescript
const loader = new DefaultResourceLoader({
  cwd: projectRoot,
  agentDir,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPrompt,
});
```

For no-tool workflows:

```typescript
const { session } = await createAgentSession({
  model,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(projectRoot),
  noTools: "all",
});
```

For Scrape Jobs, disable built-in tools while passing only the two custom tools. Verify the exact `noTools: "builtin"` and `customTools` API against the pinned Pi version in Phase 0.

Every session must:

- have a timeout;
- support cancellation;
- unsubscribe listeners;
- call `session.dispose()` in `finally`.

### Concurrency

Allow one active Pi run at a time.

```typescript
// ponytail: one global AI lock; add a queue only if personal use proves it necessary.
```

The UI disables other AI buttons while a run is active.

JSON workflows (scrape, generate, profile import, manual job parse) share one repair loop. The backend extracts a JSON object from the model text, validates schema and business rules, and on failure sends the prior output plus the validator error back to the same provider once. Interview chat, follow-up draft, and test connection stay free-form text and do not use that loop.

### Provider switching

The user edits provider/model in Settings and clicks Test connection.

No automatic fallback or model-routing framework is needed.

## 17. Architecture

```text
React dashboard
      │ HTTP + polling
      ▼
Fastify server
      ├── profile.json
      ├── profile.md          # preserved legacy backup/import source
      ├── criteria.json
      ├── settings.json
      ├── SQLite
      ├── Pi SDK
      │    └── two restricted scrape tools
      └── LaTeX/PDF child processes
```

### Repository layout

```text
job-sequencer/
├── PRD.md
├── README.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── server/
│   │   ├── index.ts
│   │   ├── db.ts
│   │   ├── ai.ts
│   │   ├── scrape.ts
│   │   ├── documents.ts
│   │   └── interview.ts
│   ├── web/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   └── api.ts
│   └── shared.ts
├── tests/
│   ├── scrape.test.ts
│   ├── ai.test.ts
│   ├── documents.test.ts
│   └── interview.test.ts
├── templates/
├── vendor/
│   └── ai-job-search-skills/ # copied unchanged from the old repository
└── data/                    # gitignored
    ├── profile.json
    ├── profile.md            # preserved legacy backup/import source
    ├── settings.json
    ├── jobs.sqlite3
    └── applications/
```

Do not add a monorepo, dependency injection, factories, generic connector SDK, or separate worker service in MVP.

## 18. Database

Use four tables.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  posting TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rank_json TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN (
      'Recommended','Discarded','Selected','Drafting','Ready',
      'Applied','Interview','Offer','Rejected','Archived'
    )
  ),
  notes TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, source_id)
);

CREATE INDEX jobs_stage_idx ON jobs(stage);
CREATE INDEX jobs_score_idx ON jobs(score);

CREATE TABLE applications (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  cv_template TEXT,
  cv_source TEXT,
  cv_pdf TEXT,
  cover_letter_source TEXT,
  cover_letter_pdf TEXT,
  verification_json TEXT,
  approved_at TEXT,
  submitted_at TEXT,
  submission_channel TEXT,
  interview_notes TEXT NOT NULL DEFAULT '',
  interview_chat_json TEXT NOT NULL DEFAULT '[]',
  follow_up_draft TEXT NOT NULL DEFAULT '',
  follow_up_due_at TEXT,
  follow_up_sent_at TEXT,
  outcome TEXT,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL CHECK (
    workflow IN ('scrape','generate','interview','follow_up','test')
  ),
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (
    status IN ('running','succeeded','failed','cancelled','timed_out')
  ),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  summary_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

Rules:

- `rank_json` stores reason, strengths, and gaps.
- `interview_chat_json` stores only the current bounded practice chat.
- document history remains in timestamped directories.
- use one transaction to persist a successful scrape result;
- use one transaction when approving documents or recording Applied;
- mark stale `running` rows failed at server startup.

## 19. API

```text
GET    /api/jobs
GET    /api/jobs/:id
PATCH  /api/jobs/:id
POST   /api/scrape
POST   /api/jobs/:id/select
POST   /api/generate
POST   /api/jobs/:id/approve
POST   /api/jobs/:id/applied
POST   /api/jobs/:id/outcome

GET    /api/profile
PUT    /api/profile
GET    /api/criteria
PUT    /api/criteria
GET    /api/settings
PUT    /api/settings

GET    /api/runs/:id
POST   /api/runs/:id/cancel
POST   /api/ai/test

GET    /api/jobs/:id/interview
POST   /api/jobs/:id/interview
DELETE /api/jobs/:id/interview
POST   /api/jobs/:id/follow-up
POST   /api/jobs/:id/follow-up/sent

GET    /api/files/:jobId/:name
```

Long actions return a run ID. The UI polls every second while the run is active.

Errors use one browser-safe shape:

```json
{
  "error": "Generated output failed validation."
}
```

## 20. Personal-use security

Keep only controls that matter:

- bind to `127.0.0.1`;
- do not enable CORS;
- reject unexpected Host headers;
- keep credentials in Pi auth storage or environment variables;
- never return credentials through APIs;
- disable Pi built-in tools and resource discovery;
- expose only the two typed scrape tools during scrape;
- validate every tool argument and result;
- reject final jobs not returned by a tool;
- treat posting text as untrusted prompt data;
- generate file paths from job IDs;
- keep resolved paths inside `data/applications/`;
- spawn compilers with argument arrays and timeouts;
- validate every AI response before persistence;
- keep `data/` in `.gitignore`.

No login, cookies, CSRF, RBAC, or generic security framework while the app is loopback-only.

## 21. Tests

### Required tests

- strict threshold: 81 is Recommended; 60 is Discarded;
- scrape result rejects unknown source IDs and URLs;
- duplicate URL upsert preserves advanced stages;
- successful scrape persists all jobs in one transaction;
- failed scrape persists none;
- selection is manual;
- generate runs only for Selected jobs;
- compile or verification failure stays Drafting;
- approval is required for Ready;
- only explicit action sets Applied;
- mock interview never changes stage;
- follow-up drafting never marks sent;
- Pi timeout, cancel, and disposal through fake sessions;
- scrape session has only two custom tools;
- other Pi sessions have no tools;
- document path containment;
- PDF page count and text extraction.
- every activated vendored CLI passes its existing tests unchanged;
- wrappers reject flags, commands, and result IDs outside their fixed allowlist.

### Live tests

Opt-in:

```text
RUN_PI_LIVE=1
RUN_SCRAPE_LIVE=1
RUN_LATEX_LIVE=1
```

Start with small samples:

- one scrape query with at most five jobs;
- three ranking outcomes: strong, borderline, mismatch;
- one document generation;
- three interview chat turns;
- one follow-up draft.

### Browser smoke

One Playwright flow after the features exist:

```text
save profile/criteria
→ scrape fixture
→ select one job
→ generate fixture
→ approve
→ mark applied
→ interview chat
→ draft follow-up
```

## 22. Roadmap

### Implementation status notation

The checklists in this roadmap and the final MVP section record the current repository status:

- `[x]` Implemented and verified by source, tests, or a passing command.
- `[~]` Partially implemented, implemented but not fully tested, or blocked by a failing acceptance check.
- `[ ]` Not implemented or not yet evidenced.

These markers do not weaken the requirements above; they make the current implementation boundary explicit.

### Phase 0 — Prove Pi and one job source

**Estimate:** 2–3 days.

Build only:

- one TypeScript package;
- copy all ten existing skill directories into `vendor/ai-job-search-skills` without rewriting them;
- run the existing tests for the default `freehire-search` CLI unchanged;
- Fastify health route;
- React smoke page;
- SQLite smoke;
- Pi no-tool `OK` response;
- Pi custom-tool session exposing only `searchJobs` and `fetchJobDetails`;
- one real source search returning at most five jobs;
- cancellation/disposal check;
- LaTeX command smoke.

Exit:

- [~] All ten skill directories are present without generated folders; the vendored tree contains the expected source/docs/tests where supplied by each skill, but not every non-CLI guidance skill has its own lockfile or test suite.
- [x] The app has no runtime dependency on an external source repository.
- [x] `freehire-search` existing tests pass unchanged (`26 passed, 0 failed`).
- [x] Default `searchJobs` and `fetchJobDetails` wrap the vendored `freehire-search` CLI instead of reimplementing it.
- [x] Pi SDK works on Node 24.
- [x] built-in tools and resource discovery are disabled.
- [x] custom-tool session exposes only two scrape tools.
- [x] one real source returns structured jobs; the live source check returned five FreeHire results.
- [x] Pi cannot return an accepted job not produced by a tool.
- [x] SQLite and LaTeX wrappers work on Windows.

Stop after Phase 0 and review the source quality before building the dashboard.

### Phase 1 — Profile, criteria, Scrape Jobs, and ranking

**Estimate:** 4–7 days plus sample review.

Build:

- profile and criteria forms;
- settings;
- four-table database;
- Scrape Jobs run/poll/cancel;
- source-specific tool implementation and sequential multi-source aggregation;
- score validation and strict threshold;
- job upsert;
- Jobs table and filters;
- selection.

Exit:

- [x] user can save profile and criteria.
- [~] scrape returns real jobs matching criteria; the live check proves source search, while a provider-backed end-to-end scrape/ranking sample is not yet recorded.
- [ ] three-job ranking sample is approved.
- [x] 81 passes and 60 is Discarded.
- [x] Discarded jobs remain viewable.
- [x] user selects jobs manually.
- [x] no later workflow starts automatically.

### Phase 2 — Generate, approve, and record Applied

**Estimate:** 4–7 days plus document review.

Build:

- template metadata;
- sequential generation for selected jobs;
- no-tool Pi drafting;
- timestamped document history;
- LaTeX/PDF verification;
- document review;
- Approve/Regenerate;
- Mark Applied.

Exit:

- [x] only Selected jobs generate documents.
- [~] one real job produces truthful CV and cover letter; deterministic fixture generation is verified, but no provider-backed personal document sample is recorded and the configured CV template is fixture-labeled.
- [~] CV is at most the configured maximum and letter is at most the configured maximum; the verification gate and deterministic document tests enforce this, but a real provider-generated sample is not recorded.
- [x] contact details extract correctly.
- [x] failures remain Drafting.
- [x] human approval is required for Ready.
- [x] human action is required for Applied.

### Phase 3 — Interview chat and follow-up

**Estimate:** 2–4 days plus practice review.

Build:

- Interview menu;
- job-context chat;
- bounded chat history;
- reset chat;
- interview notes;
- follow-up draft;
- optional due date;
- Mark sent.

Exit:

- [x] chat uses profile, posting, CV, and cover letter.
- [~] interviewer asks one question at a time; the runtime prompt requires it, but no provider-quality acceptance sample is recorded.
- [~] chat is useful for three practice turns; three deterministic turns are covered, but usefulness is not a provider-quality acceptance claim.
- [x] chat does not change job status.
- [x] follow-up requires explicit user action.
- [x] sent status requires explicit user action.

### Total estimate

| Scope | Estimate |
|---|---:|
| Through scrape and ranking | 6–10 days |
| Through document workflow | 10–17 days |
| Complete through interview/follow-up | 12–21 days |

## 23. Failure behavior

| Failure | Behavior |
|---|---|
| Job source unavailable | Fail scrape with no partial persistence |
| Provider/auth unavailable | Show error; user changes settings or retries |
| Pi timeout | Abort, dispose, mark timed out |
| User cancel | Abort, dispose, no retry |
| Invalid AI JSON | Repair once across scrape, generate, profile import, and manual job parse, then fail without persistence |
| Unknown tool result ID | Reject entire scrape output |
| Duplicate URL | Update score/posting; preserve advanced stage |
| Document compile failure | Keep Drafting |
| Configured page maximum exceeded | Keep Drafting |
| Empty ATS text | Keep Drafting |
| Database failure | Roll back transaction |
| Server restart during run | Mark stale run failed; user retries |
| Interview message fails | Keep previous chat unchanged |
| Follow-up generation fails | Keep previous draft unchanged |

No automatic fallback. No workflow starts the next workflow automatically.

## 24. Final MVP checklist

- [x] Profile and criteria can be entered from dashboard.
- [x] All existing skills are vendored in the new repository without generated folders.
- [x] Search, scoring, writing, CV, cover-letter, and interview logic reuse the mapped existing skill assets.
- [x] No portal parser or mapped guidance is reimplemented in application code.
- [x] Scrape Jobs uses Pi and sequential restricted enabled-source adapters.
- [x] Every accepted job comes from a tool result.
- [~] Jobs receive honest fit scores; the bounded scoring/validation path exists, but no provider-backed ranking-quality sample is recorded and generation truth validation remains permissive.
- [x] Score `<= 60` is Discarded; 81 is Recommended.
- [x] Discarded jobs are hidden by default, not deleted.
- [x] User selects interesting jobs manually.
- [x] Selected jobs generate CV and cover letter sequentially.
- [~] Generated PDFs pass page and ATS checks; deterministic fixture verification passes, while provider-backed document output is not yet evidenced.
- [x] Human approval is required before Ready.
- [x] Human applies outside the app.
- [x] Human explicitly marks Applied.
- [x] Interview chat uses the exact job and application documents.
- [x] Interview chat does not alter stage.
- [x] Follow-up is drafted and sent only on explicit actions.
- [x] No workflow automatically triggers the next workflow.
- [x] Pi sessions clean up after success, error, timeout, and cancel.
- [x] Personal data and credentials remain gitignored.

## 25. Deferred upgrades

| Upgrade | Add when |
|---|---|
| Automatic provider fallback | Manual retry becomes frequently annoying |
| Concurrent AI runs | One-at-a-time blocks normal personal use |
| SSE/WebSocket | Polling causes a visible UX issue |
| Structured profile facts | Manual document review repeatedly misses false claims |
| Authentication | The server is exposed beyond localhost |
| Notifications | Due follow-ups are repeatedly forgotten |
| Persistent Pi interview session | Re-sending bounded chat history causes a measured quality or cost problem |

## 26. Handoff

Start the next session with:

```text
Create a new project in a new work directory using:
`docs/GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md`

Do not modify ai-job-search. Use ponytail full. Implement Phase 0 only:
reuse `vendor/ai-job-search-skills` without rewriting it or copying generated folders;
run the default freehire-search CLI's existing tests; create one package,
Pi SDK no-tool smoke, exactly two restricted tools wrapping the existing
freehire-search CLI, one live search with at most five results, SQLite smoke,
Fastify/React smoke, cancellation/disposal, and LaTeX command smoke. Run every
Phase 0 check, then stop and report real output.
```

## 27. Changelog

### v1.3

- Made reuse of `vendor/ai-job-search-skills` mandatory.
- Inventoried and mapped all ten existing skill directories.
- Required copying the skills into the new repository so runtime does not depend on the old worktree.
- Made the existing `freehire-search` CLI the default source implementation behind the two restricted Pi tools.
- Required existing CLI tests to pass unchanged and prohibited portal-parser rewrites.

### v1.2

- Corrected the product around the actual user-triggered workflow.
- Scrape and rank are one bounded action.
- Jobs scoring `>60` become Recommended; `<=60` become Discarded.
- Selection, generation, approval, Applied, interview chat, and follow-up are separate manual actions.
- Added restricted Pi scrape tools and sequential enabled-source aggregation with backward-compatible settings migration.
- Added Interview chat using the stored job, CV, and cover letter.
- Added manually drafted and manually sent follow-up.
- Removed manual import as the primary workflow.
- Kept personal-use architecture with four tables and no SaaS systems.

### v1.1

- Simplified the original enterprise-style proposal for personal local use.

### v1.0

- Original comprehensive greenfield proposal; superseded.
