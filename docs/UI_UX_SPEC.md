# Job Sequencer — UI/UX Functional Specification

## 1. Purpose

This document describes what users can see and do in the Job Sequencer dashboard.

### Runtime entry

Tracker is the only frontend. Opening `/` boots the Tracker application, whose PATTERN, SAMPLE, ORDER, PHRASE, DISK, and TRACE surfaces cover the job, application, interview, configuration, and run workflows described below. `/tracker.html` remains an explicit compatibility entry for the same Tracker app; no secondary frontend route is supported.

It covers:

- application menus;
- pages and page content;
- user actions;
- navigation between pages;
- action availability by job stage;
- loading, success, empty, and error behavior;
- the manual boundaries between workflows.

Visual design is defined separately so this document can remain focused on behavior and workflow:

- [`VISUAL_DESIGN_SPEC.md`](./VISUAL_DESIGN_SPEC.md)
- [Clickable HTML prototype](../design/personal-job-search-prototype.html)

The product and technical requirements remain defined in:

- [`GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md`](./GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md)

## 2. User model

The application has one local user.

There is:

- no sign-in page;
- no account menu;
- no role or permission management;
- no organization/workspace switcher;
- no onboarding wizard.

If required profile or criteria data is missing, the relevant action explains what is missing and links directly to **Profile & Criteria**.

## 3. Main navigation

The application has five primary menus:

1. **Jobs**
2. **Applications**
3. **Interview**
4. **Profile & Criteria**
5. **Settings**

### Default destination

Opening the application goes to Tracker **PATTERN**.

### Menu responsibilities

| Menu | Purpose |
|---|---|
| Jobs | Scrape, review, filter, score, and select jobs |
| Applications | Generate documents, approve documents, record manual applications, and manage follow-up |
| Interview | Practice interviews for applied jobs |
| Profile & Criteria | Maintain candidate facts and job-search preferences |
| Settings | Select the Pi provider/model, job sources, score threshold, and test the AI connection |

The same operation should not be duplicated across several menus unless it provides a necessary shortcut. The canonical location for each operation is defined below.

## 4. Global application behavior

### 4.1 Active AI run

Only one Pi action may run at a time.

While an AI action is active:

- the application shows the workflow name;
- the application shows which job is being processed when applicable;
- the application shows progress text returned by the backend;
- a **Cancel** action is available;
- other actions that would start Pi are disabled;
- normal browsing, filtering, notes, and status viewing remain available.

Closing or navigating away from the initiating page does not cancel the run. Returning to the page restores the current run state from the backend.

### 4.2 Operation results

Every long-running operation ends in one of these states:

- Running
- Succeeded
- Failed
- Cancelled
- Timed out

On success, show a short result summary and a link to the affected job or application.

On failure, show:

- a short user-readable reason;
- what was and was not saved;
- a **Retry** action when retrying is safe;
- a link to Settings when provider configuration caused the error.

Do not display credentials, full prompts, or raw stack traces in the browser.

### 4.3 Unsaved changes

Profile, criteria, notes, interview notes, and follow-up edits indicate when they have unsaved changes.

If the user navigates away with unsaved changes, ask whether to discard them.

### 4.4 External links

Job posting and application links open outside the dashboard.

Opening an external job posting never changes the job stage. Only an explicit **Mark as Applied** action changes a job to Applied.

### 4.5 No automatic continuation

Completing one workflow never starts the next workflow.

Examples:

- scraping does not select a job;
- selection does not generate documents;
- successful document verification does not approve documents;
- approval does not open or submit the job application;
- marking Applied does not start interview practice;
- interview practice does not draft a follow-up;
- generating a follow-up does not send it.

## 5. Jobs

**Jobs** is the landing dashboard.

It contains:

- the job list;
- search and filters;
- job-source status;
- the **Scrape Jobs** action;
- job selection actions;
- access to each job's details.

### 5.1 Jobs summary

Show counts for:

- Recommended
- Discarded
- Selected
- Drafting
- Ready
- Applied
- Interview

The counts are navigation shortcuts that apply the corresponding stage filter.

Offer and Rejected remain available in stage filters but do not require dedicated summary counts in MVP.

### 5.2 Job list

The job list always uses these columns:

| Column | Content |
|---|---|
| Company / role | Company and job title; opens job details |
| Location | Stored location or `Not specified` |
| Stage | Current workflow stage |
| Score | Fit score or `Not scored` |
| Source | Job source |
| First seen | Date the job first entered the database |

Fit filters change which rows are shown. They do not change the table columns.

### Default rows

By default, show jobs in these stages:

- Recommended
- Selected
- Drafting
- Ready
- Applied
- Interview
- Offer

Discarded, Rejected, and Archived jobs are available through filters.

### Search and filters

Provide:

- text search across company and role;
- stage filter;
- minimum score filter;
- source filter;
- location text filter;
- sort by score;
- sort by first-seen date.

A **Clear filters** action restores the default job list.

Filters do not change persisted job data.

### Row selection

The user may select one or more visible jobs for bulk stage selection.

Bulk actions in MVP:

- **Select jobs**
- **Unselect jobs**
- **Archive**

Document generation is started from Applications, not from a generic Jobs bulk-action menu.

### 5.3 Scrape Jobs

The canonical **Scrape Jobs** action is in Jobs.

### Before the run

Before starting, show a confirmation summary containing:

- active profile status;
- active search criteria summary;
- enabled source labels;
- active provider and model;
- configured fit threshold;
- maximum jobs for the run.

Available actions:

- **Start scrape**
- **Cancel**
- **Edit profile or criteria**
- **Open Settings**

Disable **Start scrape** when:

- the profile is missing or empty;
- no target role is configured;
- no search location is configured;
- the provider/model is incomplete;
- another Pi run is active.

### During the run

Show:

- current run status;
- current activity description;
- jobs found so far when available;
- **Cancel run**.

Do not show results as persisted jobs until the run succeeds. A failed or cancelled scrape does not leave a partially imported result set.

### After success

Show a result summary:

- jobs found;
- Recommended jobs;
- Discarded jobs;
- duplicate jobs updated or skipped;
- source errors, if any.

Available actions:

- **View Recommended**
- **View Discarded**
- **Close summary**

The threshold classification is automatic, but selection remains manual.

### 5.4 Job details

Opening a job displays:

### Job information

- role;
- company;
- location;
- source;
- source URL;
- full stored posting;
- first-seen date;
- last-updated date.

### Fit assessment

- score;
- recommendation stage;
- concise reason;
- matching strengths;
- gaps or requirements to confirm.

### Workflow information

- current stage;
- generated document status;
- approval date, if approved;
- submitted date, if applied;
- interview status;
- follow-up status;
- personal notes.

### Job actions

Actions depend on stage:

| Stage | Available actions |
|---|---|
| Recommended | Select, Open posting, Edit notes, Archive |
| Discarded | Restore to Recommended, Open posting, Edit notes, Archive |
| Selected | Unselect, Open application, Open posting, Edit notes, Archive |
| Drafting | Open application, Retry generation, Open posting, Edit notes, Archive |
| Ready | Open application, Open posting, Mark as Applied, Edit notes, Archive |
| Applied | Open application, Open interview practice, Draft follow-up, Edit notes, Change outcome |
| Interview | Open application, Open interview practice, Draft follow-up, Edit notes, Change outcome |
| Offer | Open application, Edit notes, Change outcome, Archive |
| Rejected | Open application, Edit notes, Archive |
| Archived | Restore to its previous active stage |

The application should not provide permanent deletion in MVP.

## 6. Applications

Applications contains jobs from Selected onward.

It is the canonical menu for:

- generating CVs and cover letters;
- reviewing generated documents;
- approving documents;
- recording manual applications;
- entering interview/application notes;
- drafting follow-up messages;
- recording outcomes.

### 6.1 Application board

Applications uses a horizontally scrollable Kanban board grouped by workflow stage.

Show lanes for:

- Selected
- Drafting
- Ready
- Applied
- Interview
- Outcomes, containing Offer and Rejected jobs

Lane order is fixed and follows the workflow from left to right. Each lane header shows its name and visible item count.

The board is a stage overview, not a drag-and-drop pipeline. Cards cannot be dragged between lanes. A job changes stage only through the explicit stage-specific actions defined in this specification, including document approval, Mark as Applied, and outcome management. This preserves confirmations and prevents accidental workflow transitions.

Provide filters for:

- stage;
- company or role;
- document status;
- follow-up state.

Each application card shows:

- company and role;
- score;
- current stage;
- CV status;
- cover-letter status;
- approval status;
- submission date, if available;
- follow-up due/sent status, if available.

The card also shows one stage-appropriate primary action. Clicking the company or role opens Application details. Checkboxes used for batch generation do not open the card and do not change its stage.

On narrow screens, lanes remain columns inside a horizontally scrollable board. Do not convert the workflow into an unrelated card feed or hide stages in a select menu.

### 6.2 Selected jobs

For a Selected job, the primary action is:

- **Generate CV & Cover Letter**

When several jobs are Selected, the user may choose:

- generate for one job; or
- generate for all currently selected jobs.

Batch generation processes jobs sequentially and reports success or failure separately for every job.

Starting generation changes the affected job to Drafting.

### 6.3 Generation progress

While generating documents, show:

- current company and role;
- current step;
- completed jobs and pending jobs for a batch;
- per-job failure message;
- **Cancel current run**.

Cancelling a batch stops after the currently active request is cancelled. Jobs that already succeeded retain their generated documents. Jobs not yet started remain Selected.

The application does not automatically approve successful documents.

### 6.4 Application details

Application details contain these sections.

### Job context

Show:

- company and role;
- job URL;
- fit score;
- strengths;
- gaps;
- relevant posting content.

### Documents

For CV and cover letter, show:

- generation status;
- source file link;
- PDF file link;
- last-generated timestamp;
- selected CV template;
- previous versions when available.

### Verification

Show pass/fail for:

- compilation;
- expected PDF presence;
- CV page count;
- cover-letter page count;
- PDF text extraction;
- literal email presence;
- literal phone presence.

If verification fails, identify the failed checks and keep the job in Drafting.

### Document review actions

When generation and verification succeed:

- **Approve documents**
- **Regenerate documents**
- **Reject draft**
- **Open CV PDF**
- **Open cover-letter PDF**
- **Open source files**

**Approve documents** requires explicit confirmation that the user reviewed both documents. Approval changes Drafting to Ready.

**Regenerate documents** creates another version and keeps the job in Drafting.

**Reject draft** keeps the job in Drafting and allows the user to add revision notes before regeneration.

### Ready application actions

For a Ready job:

- **Open job posting**
- **Open CV PDF**
- **Open cover-letter PDF**
- **Mark as Applied**
- **Regenerate documents**

Opening the posting or downloading files does not mark the job Applied.

### 6.5 Mark as Applied

The user invokes **Mark as Applied** only after submitting outside the dashboard.

The action asks for:

- submission date, defaulting to today;
- application channel or portal, optional;
- notes, optional.

Available actions:

- **Confirm Applied**
- **Cancel**

After confirmation:

- the stage becomes Applied;
- submission information is stored;
- the application becomes available in Interview;
- no interview chat or follow-up starts automatically.

### 6.6 Outcome management

For Applied, Interview, and Offer jobs, the user may record:

- Interview
- Offer
- Rejected
- Archived

Changing to Interview means a real interview has been scheduled or confirmed. Starting a mock interview does not perform this transition.

The user may add outcome notes before saving.

### 6.7 Follow-up

Follow-up is managed from Application details for Applied and Interview jobs.

### Follow-up input

The user may enter:

- purpose;
- recipient/interviewer name, optional;
- interview or application context;
- desired tone;
- due date, optional.

Primary action:

- **Draft follow-up**

### Follow-up result

After Pi generates a draft, the user may:

- edit the draft;
- copy the draft;
- regenerate it;
- save edits;
- mark it sent.

**Mark sent** asks for confirmation and stores the sent timestamp.

The application does not send email or messages.

A failed generation preserves the previous saved draft.

## 7. Interview

Interview provides mock interview chat for jobs in Applied or Interview stage.

### 7.1 Interview job list

List eligible jobs with:

- company and role;
- current stage;
- fit score;
- latest practice timestamp;
- real interview date or note, if entered.

Provide search by company or role and filters for Applied and Interview.

Primary action:

- **Practice interview**

Jobs that are not Applied or Interview do not appear here.

### 7.2 Interview workspace

The user chooses one eligible job before starting.

Show the active context summary:

- company and role;
- current stage;
- job requirements;
- fit strengths and gaps;
- generated CV status;
- generated cover-letter status.

The user may provide an optional practice focus, such as:

- behavioral interview;
- Java/Spring technical questions;
- system design;
- role-specific gaps;
- hiring-manager interview.

### Chat behavior

The user may:

- start practice;
- answer Pi's question;
- continue to the next question;
- ask Pi to clarify feedback;
- stop practice;
- reset the current chat.

Pi:

- asks one interview question at a time;
- waits for the user's response;
- gives concise feedback;
- identifies weak or unsupported claims;
- helps improve truthful answers;
- uses the selected job, profile, CV, and cover letter as context.

### Chat state

While a message is running:

- prevent duplicate submissions;
- allow cancellation;
- preserve all messages completed before the failed or cancelled request.

The latest bounded chat history is saved automatically.

**Reset chat** requires confirmation and clears the saved practice conversation for that job. It does not delete notes or change the job stage.

### 7.3 Interview notes

The user may maintain private interview notes for the selected job.

Notes are separate from chat messages and may include:

- real interview date;
- interviewer names;
- questions asked;
- topics to review;
- post-interview observations.

Saving notes does not generate a follow-up automatically.

A shortcut may open the same job's Follow-up section in Applications.

## 8. Profile & Criteria

This menu contains two independently saved sections:

1. Profile
2. Search Criteria

It also provides a shortcut to start Scrape Jobs after both sections are valid.

### 8.1 Profile

The user can view and edit the candidate profile used by Pi.

Required profile areas:

- identity and contact information;
- location;
- work authorization and relocation preference;
- professional experience;
- education;
- technical skills;
- certifications;
- projects and awards;
- languages;
- target roles;
- deal-breakers.

The Profile editor uses structured fields rather than one free-form Markdown field.

### Identity and contact fields

- first name;
- last name;
- professional headline;
- email address;
- phone number;
- city or region;
- country;
- portfolio or personal website, optional;
- LinkedIn URL, optional;
- GitHub URL, optional;
- professional summary.

### Work preferences and eligibility fields

- work-authorization status;
- relocation preference;
- remote-work preference;
- target roles;
- deal-breakers.

### Repeatable profile entries

Professional experience entries contain:

- job title;
- company;
- employment type, optional;
- location, optional;
- start month and year;
- end month and year, or a current-role flag;
- factual description and achievements.

Education entries contain:

- institution;
- degree;
- field of study, optional;
- start month and end month, captured as month and year values;
- year-only start/end fallbacks when a month is not known;
- GPA, optional.

The following are repeatable structured collections:

- technical skills;
- certifications, with issuer and issue date where available;
- projects, with role, description, dates, and URL where available;
- awards, with issuer and date where available;
- languages, with proficiency description.

The user can add, edit, reorder, and remove repeatable entries. Removing a saved entry requires confirmation. The editor does not infer missing facts or rewrite factual content automatically.

Actions:

- **Save profile**
- **Discard changes**

Before the first Pi action, the user must be able to review the exact profile content that will be sent to the configured provider.

The application must not silently add skills or experience to the profile.

### 8.2 Search Criteria

The user can edit:

- target roles;
- target locations;
- remote-only preference;
- required/preferred keywords;
- excluded keywords;
- employment types;
- maximum jobs per scrape run.

Actions:

- **Save criteria**
- **Discard changes**

Validation behavior:

- require at least one target role;
- require at least one location;
- require a positive maximum-job limit;
- explain invalid fields before saving.

### 8.3 Scrape shortcut

When Profile and Criteria are both saved and valid, provide:

- **Scrape Jobs**

This opens the same pre-run confirmation used by Jobs. It does not implement a second scrape workflow.

## 9. Settings

Settings contains non-secret runtime configuration.

### 9.1 AI settings

The user can view and edit:

- provider;
- model.

Actions:

- **Save settings**
- **Test connection**

Testing the connection reports:

- Succeeded; or
- Failed with a short reason.

Testing does not scrape jobs or modify any job.

API credentials remain outside the dashboard. If credentials are missing, explain where the configured provider expects them without displaying or accepting the secret value.

### 9.2 Search settings

The user can configure:

- enabled built-in source checkboxes;
- an accessible maximum-age-in-days control beside each built-in source; defaults are effectively unlimited for FreeHire/LinkedIn and 45 days for TokyoDev/Japan Dev;
- custom source list with add, edit, enable/disable, and remove actions;
- bounded HTTP(S) URL templates and declarative JSON/HTML parser configuration only; no arbitrary commands or user code;
- fit threshold;
- maximum results where not overridden by criteria.

The passing rule is always strict:

```text
score > configured threshold  → Recommended
score <= configured threshold → Discarded
```

Changing the threshold affects future scrape results. It does not silently reclassify existing advanced stages such as Selected, Drafting, Ready, Applied, Interview, Offer, or Rejected.

When a built-in source is allowed beyond 45 days and returns dated postings older than 45 days, the run remains successful but shows a bounded warning to verify that the postings are still active. Run warnings and per-source errors remain visible in the global run status. After server-side changes, rebuild and restart the API; restart the long-lived Vite process after frontend changes so the controls are loaded.

### 9.3 Document settings

The user can view:

- maximum CV page count;
- maximum cover-letter page count;
- available CV templates;
- cover-letter template status;
- LaTeX/PDF tool availability.

MVP does not require a template editor. Template files are managed in the project directory.

Provide a status check that reports missing templates or required executables.

## 10. Stage and action matrix

| Stage | Visible in Jobs | Visible in Applications | Visible in Interview | Primary user action |
|---|---:|---:|---:|---|
| Recommended | Yes | No | No | Select or discard |
| Discarded | Through filter | No | No | Restore or archive |
| Selected | Yes | Yes | No | Generate documents |
| Drafting | Yes | Yes | No | Review, retry, or regenerate |
| Ready | Yes | Yes | No | Apply manually and mark Applied |
| Applied | Yes | Yes | Yes | Practice interview or draft follow-up |
| Interview | Yes | Yes | Yes | Practice, add notes, or draft follow-up |
| Offer | Yes | Yes | No | Record outcome or archive |
| Rejected | Through filter | Yes | No | Review notes or archive |
| Archived | Through filter | No | No | Restore |

## 11. Navigation flows

### 11.1 First-use flow

```text
Open application
→ Profile & Criteria
→ Save Profile
→ Save Criteria
→ Settings
→ Select provider/model and enable one or more sources
→ Test connection
→ Jobs
→ Scrape Jobs
```

The application does not need a dedicated onboarding wizard.

### 11.2 Discover and select flow

```text
Jobs
→ Scrape Jobs
→ Wait for result
→ View Recommended
→ Open job details
→ Review score, strengths, and gaps
→ Select job
→ Applications
```

### 11.3 Document flow

```text
Applications
→ Selected job
→ Generate CV & Cover Letter
→ Wait for generation and verification
→ Open application details
→ Review CV and cover letter
→ Approve or Regenerate
```

### 11.4 Manual application flow

```text
Applications
→ Ready job
→ Open posting and documents
→ Apply outside dashboard
→ Return to application
→ Mark as Applied
```

### 11.5 Interview-practice flow

```text
Interview
→ Choose Applied or Interview job
→ Enter optional practice focus
→ Start practice
→ Answer questions and review feedback
→ Stop practice
```

### 11.6 Follow-up flow

```text
Applications
→ Applied or Interview job
→ Follow-up
→ Enter context
→ Draft follow-up
→ Review/edit/copy
→ Send outside dashboard
→ Mark sent
```

## 12. Empty states

| Page or section | Empty-state behavior |
|---|---|
| Jobs, no profile | Explain that a profile is required; link to Profile & Criteria |
| Jobs, no criteria | Explain that search criteria are required; link to Profile & Criteria |
| Jobs, no jobs | Offer Scrape Jobs after prerequisites are valid |
| Recommended, no matches | State that no jobs passed the configured threshold; offer View Discarded or Scrape again |
| Discarded, empty | State that no jobs were discarded |
| Applications, empty | Explain that selected jobs appear here; link to Jobs |
| Interview, empty | Explain that Applied and Interview jobs appear here; link to Applications |
| Documents, none | Offer Generate CV & Cover Letter when the job is Selected |
| Follow-up, none | Offer Draft follow-up for eligible stages |
| Interview chat, new | Offer practice focus and Start practice |

Empty states should direct the user to one relevant next action, not automatically perform it.

## 13. Error and recovery behavior

| Situation | User experience |
|---|---|
| Scrape source unavailable | Explain that nothing was imported; offer Retry or Settings |
| Scrape cancelled | Explain that no partial results were saved |
| Invalid Pi scrape result | Explain validation failure; save no scrape results |
| Duplicate job | Show the existing job updated; do not create another row |
| Generation fails | Keep Drafting; show failed step and Retry |
| Compilation fails | Keep Drafting; show a safe compiler summary |
| PDF verification fails | Keep Drafting; list failed checks |
| Approval attempted before verification | Block approval and show required passing checks |
| Mark Applied attempted before Ready | Block action and link to document review |
| Interview message fails | Preserve previous messages and allow Retry |
| Follow-up generation fails | Preserve previous draft and allow Retry |
| Connection test fails | Keep saved settings; show reason and allow another test |
| Server restarted during run | Mark run failed and let the user restart that action |

## 14. Confirmation rules

Require confirmation for actions that alter important workflow state or remove user work:

- approve documents;
- mark as Applied;
- mark follow-up sent;
- archive a job;
- restore an archived job;
- reset interview chat;
- discard unsaved edits.

Do not require confirmation for:

- opening a job;
- opening a PDF;
- changing filters;
- copying follow-up text;
- starting interview practice;
- selecting or unselecting a Recommended job.

## 15. Functional acceptance checklist

### Navigation

- [ ] Jobs is the default page.
- [ ] All five primary menus are reachable directly.
- [ ] Navigation does not cancel an active Pi run.

### Jobs

- [ ] The full job table always uses the six required columns.
- [ ] Discarded jobs are hidden by default but remain accessible.
- [ ] Scrape Jobs shows the active profile, criteria, enabled sources, model, threshold, and limit before starting.
- [ ] Scrape completion does not select jobs automatically.
- [ ] The user can inspect score reasons, strengths, and gaps before selecting.

### Applications

- [ ] Only selected jobs are eligible for document generation.
- [ ] Batch generation reports each job separately.
- [ ] Generated source, PDFs, and verification checks are reviewable.
- [ ] Verification success does not approve documents automatically.
- [ ] Only explicit approval changes the job to Ready.
- [ ] Opening a posting does not mark Applied.
- [ ] Only explicit confirmation changes the job to Applied.

### Interview

- [ ] Only Applied and Interview jobs are available for practice.
- [ ] The active job context is clear before practice begins.
- [ ] Pi asks one question at a time.
- [ ] Previous messages survive a failed new message.
- [ ] Practice does not change the job stage.

### Profile, criteria, and settings

- [ ] Profile and criteria save independently.
- [ ] Profile identity, contact, experience, education, skills, and other professional facts use structured fields.
- [ ] Repeatable profile entries can be added, edited, reordered, and removed without editing raw Markdown.
- [ ] Invalid criteria explain what must be fixed.
- [ ] The user can review the profile sent to the provider.
- [ ] Provider/model connection can be tested without modifying jobs.
- [ ] Changing the threshold does not overwrite advanced job stages.

### Follow-up

- [ ] Follow-up generation requires a user action.
- [ ] The generated draft can be edited and copied.
- [ ] The dashboard never sends the message.
- [ ] Only explicit confirmation records the draft as sent.

## 16. Explicit UI/UX non-goals

This specification does not require:

- a home page separate from Jobs;
- an admin page;
- account or organization menus;
- notification center;
- activity feed;
- analytics dashboard;
- calendar integration;
- email client;
- drag-and-drop stage transitions; the Applications Kanban is navigation and status presentation only;
- template editor;
- embedded job-application browser;
- automatic application submission;
- autonomous movement through workflow stages.

Add these only if regular personal use demonstrates a real need.
