# Job Sequencer — Visual Design Specification

**Version:** 1.0  
**Status:** Implementation-ready  
**Companion to:** [`UI_UX_SPEC.md`](./UI_UX_SPEC.md)  
**Prototype:** [`../design/personal-job-search-prototype.html`](../design/personal-job-search-prototype.html)

### Runtime entry

Tracker is the only frontend at `/`, with `/tracker.html` retained as an explicit compatibility entry. The surfaces described here are Tracker-first; no secondary frontend route is supported.

## 1. Design direction

### Working title: Tracker

The dashboard should feel like a serious personal workbench: a well-kept paper file, a marked-up shortlist, and a precise operations console. It should not resemble a generic SaaS analytics product or an AI chat wrapper.

The visual language combines:

- warm paper-like neutrals rather than cold gray or pure white;
- dense, legible tables rather than grids of decorative cards;
- near-black structural chrome;
- one signal-yellow accent for selection and primary workflow actions;
- blue only for links and focus;
- sharp geometry with very restrained rounding;
- editorial labels, ruled dividers, and compact status marks;
- visible manual gates between consequential workflow steps.

The result should feel **opinionated, calm, practical, and human-made**.

### Personality

| Attribute | Target |
|---|---|
| Confident | Strong hierarchy and decisive labels |
| Personal | Warm surfaces and plain language |
| Precise | Tabular alignment, explicit states, visible timestamps |
| Energetic | Yellow accent and occasional angled label treatment |
| Trustworthy | No invented metrics, no ambiguous automation claims |
| Efficient | High information density without cramped controls |

### Explicit anti-slop rules

Do not use:

- gradients;
- glassmorphism or blurred translucent panels;
- a dashboard made primarily from rounded cards;
- oversized empty hero headings;
- decorative AI sparkles, robot icons, magic wands, or “AI-powered” badges;
- rainbow status colors;
- generic KPI cards with arbitrary growth percentages;
- excessive pills;
- icons where a clear text label scans faster;
- shadows on every container;
- centered layouts for operational pages;
- purple as an AI shorthand;
- fake activity feeds or fake productivity metrics.

A component must communicate state, enable an action, or improve scanning. Otherwise omit it.

## 2. Information architecture

### Desktop shell

```text
┌──────────────────────┬─────────────────────────────────────────────────┐
│ Product rail         │ Utility header                                  │
│                      ├─────────────────────────────────────────────────┤
│ Jobs                 │ Optional global run strip                       │
│ Applications         ├─────────────────────────────────────────────────┤
│ Interview            │ Page title / context / primary action           │
│                      ├─────────────────────────────────────────────────┤
│ Profile & Criteria   │ Page content                                    │
│ Settings             │                                                 │
│                      │                                                 │
│ Local only           │                                                 │
└──────────────────────┴─────────────────────────────────────────────────┘
```

- Left rail: `224px` fixed width.
- Utility header: `64px` height.
- Main content: fluid with a practical maximum of `1440px`.
- Main page padding: `32px` desktop, `24px` compact desktop/tablet, `16px` mobile.
- The rail is structural navigation, not a floating card.
- PATTERN is the default active destination.

### Canonical routes

```text
/                    → #/pattern
#/pattern            → PATTERN job list and ranking
#/sample/:id          → SAMPLE job/application detail
#/order[/focus]       → ORDER application stages and follow-up
#/phrase/:jobId       → PHRASE interview workspace
#/disk                → DISK profile, criteria, and settings
#/trace[/runId]       → TRACE run history and trajectory
```

Application and follow-up shortcuts stay inside ORDER; job details open in SAMPLE.

### Mobile shell

Below `760px`:

- rail becomes a 56px top bar;
- a Menu button opens a full-height navigation sheet;
- page actions stay below the title rather than being squeezed into the top bar;
- tables become horizontally scrollable only when all required columns cannot remain readable;
- no required Jobs column is silently removed;
- detail layouts stack into one column.

## 3. Design tokens

### 3.1 Color

```css
:root {
  --canvas: #eee9df;
  --surface: #fffdf8;
  --surface-subtle: #f6f2e9;
  --surface-strong: #e2dccf;

  --ink: #171713;
  --ink-soft: #45423c;
  --ink-muted: #6b675f;
  --line: #cbc4b7;
  --line-strong: #8f897f;

  --signal: #f2c94c;
  --signal-hover: #e8b92f;
  --signal-soft: #fff3bd;

  --link: #2555d9;
  --link-hover: #173aa2;
  --focus: #2555d9;

  --success: #176b46;
  --success-soft: #dceee5;
  --danger: #a92f2b;
  --danger-soft: #f5ddda;
  --warning: #8a5a00;
  --warning-soft: #fae8b3;
  --info-soft: #dfe8ff;

  --rail: #171713;
  --rail-text: #f8f4e9;
  --rail-muted: #aaa59b;
}
```

Rules:

- Signal yellow is the only brand accent.
- Use yellow behind dark text, never as small yellow text on white.
- Blue is reserved for hyperlinks and keyboard focus.
- Green, red, and amber are semantic only.
- Stage labels primarily use neutral styling; do not assign every stage a different saturated color.

### 3.2 Typography

Use local/system fonts; the product must not depend on a font CDN.

```css
--font-ui: "Segoe UI Variable", "Segoe UI", Arial, sans-serif;
--font-display: "Arial Narrow", "Aptos Display", "Segoe UI", sans-serif;
--font-mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
```

| Role | Size | Weight | Line height | Treatment |
|---|---:|---:|---:|---|
| Page title | 32px | 750 | 1.08 | `-0.025em`, display stack |
| Detail title | 26px | 750 | 1.12 | `-0.02em` |
| Section title | 18px | 700 | 1.3 | no decorative icon |
| Body | 15px | 400 | 1.5 | primary reading text |
| UI label | 13px | 650 | 1.35 | compact and direct |
| Table heading | 11px | 750 | 1.25 | uppercase, `0.065em` |
| Metadata | 12px | 500 | 1.35 | muted or mono |
| Score | 18px | 750 | 1 | tabular numerals |

Rules:

- Use type before boxes to establish hierarchy.
- Use uppercase only for table headers, eyebrow labels, and compact operational metadata.
- Use `font-variant-numeric: tabular-nums` for scores, counts, dates, and progress.
- Body copy should not exceed `72ch`.

### 3.3 Spacing

Base scale:

```text
4, 8, 12, 16, 24, 32, 48, 64
```

- Inline icon/text gap: `8px`.
- Form field gap: `16px`.
- Related control cluster: `8px`.
- Section gap: `32px`.
- Major page zone gap: `48px`.
- Table cell padding: `12px 16px`.

Do not invent arbitrary spacing unless required for optical alignment.

### 3.4 Shape and depth

```css
--radius-control: 4px;
--radius-panel: 6px;
--radius-pill: 999px;
--shadow-overlay: 0 18px 50px rgb(23 23 19 / 0.20);
```

- Buttons, inputs, panels: 4–6px radius.
- Status marks may be pills.
- Standard panels have borders, not shadows.
- Shadows are reserved for dialogs, menus, and the mobile navigation sheet.
- Never stack multiple raised cards inside each other.

### 3.5 Motion

- Hover/focus transitions: `120ms`.
- Opening dialog/sheet: `160ms` opacity + 8px translation.
- No looping animation.
- Loading uses textual progress and, where useful, a thin determinate bar.
- Respect `prefers-reduced-motion: reduce`.

## 4. Application shell

### 4.1 Product rail

The rail uses near-black chrome to give the workspace a stable spine.

Header treatment:

```text
TRACKER  LOCAL
```

- Wordmark is text, not an invented logo.
- “BETA” is a small yellow rectangular label.
- Primary links are 44px minimum height.
- Active item uses a yellow block and dark text, not a tiny indicator line.
- Inactive items are rail-muted and turn white on hover.
- Profile & Criteria and Settings are separated from workflow menus by a ruled divider.
- Bottom of rail shows `LOCAL ONLY · 127.0.0.1` in mono text.

### 4.2 Utility header

Contains only global utilities:

- current date or local-runtime label;
- enabled source status;
- provider/model compact status;
- global run state when no run strip is visible.

Do not place page-specific primary actions here.

### 4.3 Global run strip

Visible below the utility header whenever a Pi run is active.

Structure:

```text
GENERATING  CV & Cover Letter — Northstar Labs / Backend Engineer
            Compiling CV · 2 of 4 jobs complete        [Cancel run]
            ━━━━━━━━━━━━━━━━━━━━━━━──────────── 50%
```

- Background: signal yellow.
- Workflow label: dark rectangular inverse tag.
- The run strip persists across navigation.
- Cancel is a clear text button with dark border.
- Other Pi-starting actions are disabled but browsing remains usable.
- Completed-with-errors uses yellow, not red; total failure uses danger-soft.

## 5. Core components

### 5.1 Buttons

#### Primary

- Ink background, white text.
- 40px standard height; 44px when used as the dominant page action.
- Optional yellow 4px bottom edge for distinctive emphasis.
- One primary action per page section.

#### Signal

Use for the canonical **Scrape Jobs** action and active bulk commitment.

- Yellow background, ink text, ink border.
- Never pair two signal buttons beside each other.

#### Secondary

- Transparent or surface background.
- 1px line-strong border.
- Ink text.

#### Ghost

- No container by default.
- Underline or subtle surface on hover.
- Used for Clear filters, Cancel, Open source, and low-priority navigation.

#### Danger

- Danger background only inside confirmation dialogs.
- Normal page-level archive actions remain neutral until confirmed.

All controls:

- minimum target `40 × 40px`, `44 × 44px` on mobile;
- visible `2px` focus outline plus `2px` offset;
- disabled state keeps readable labels and uses 45% opacity.

### 5.2 Inputs

- Surface background.
- 1px line border, 2px ink bottom edge on active text fields.
- Labels always visible above the field.
- Helper/error text below.
- Error treatment uses danger text and border; never color alone.
- Search input can include one magnifier icon; other text fields remain icon-free.

### 5.3 Status marks

Stage marks use compact labels with a left square indicator:

```text
■ RECOMMENDED
■ DRAFTING
■ APPLIED
```

Treatment groups:

| Group | Stages | Treatment |
|---|---|---|
| Discovery | Recommended, Discarded | neutral/signal-soft |
| Document | Selected, Drafting, Ready | yellow/ink progression |
| Active application | Applied, Interview | info/success progression |
| Outcome | Offer, Rejected | success/danger |
| Inactive | Archived | muted outline |

Do not assign unrelated hues merely to make the list colorful.

### 5.4 Summary counters

Counters are a single ruled strip, not seven detached cards.

```text
RECOMMENDED  18 | DISCARDED  7 | SELECTED  4 | DRAFTING  2 | ...
```

- Each segment is a button.
- Active filter has signal-yellow background.
- Number is visually dominant but not oversized.
- Horizontal scroll on small viewports.

### 5.5 Tables

The Jobs table is the core product surface.

- Six required columns remain present: Company/role, Location, Stage, Score, Source, First seen.
- Checkbox selection is a narrow leading utility column and does not count as a content column.
- Row height target: `64–72px`.
- Header remains visible while scrolling a long list.
- Rows use ruled separators and alternating surface tint only when helpful.
- Hover is a subtle signal-soft wash.
- Selected rows have an ink 3px left edge and signal-soft background.
- Company is semibold; role is secondary line.
- Score uses tabular numerals and right alignment.
- Source and First seen use compact metadata text.
- Clicking company/role opens detail. Checkboxes do not trigger navigation.

Mobile: preserve all data through horizontal scrolling; optionally make Company/role sticky as the first content column.

### 5.6 Filter bar

Desktop order:

```text
[Search company or role................] [Stage ▾] [Min score] [Source ▾]
[Location..............................] [Sort ▾]             [Clear filters]
```

At wide widths, this may occupy one line. At smaller widths it wraps deliberately into two rows.

- Filter controls use compact 36–40px height.
- Applied filters appear below as removable plain tags only when they improve clarity.
- “Clear filters” is always text, not an icon-only button.
- Zero-match state appears directly below the filter bar.

### 5.7 Panels and sections

A page is divided by spacing and ruled headings rather than nesting every region in a card.

Use bordered panels for:

- pre-run summaries;
- verification results;
- document preview frames;
- focused forms;
- empty/error states.

Do not put the page title, summary strip, filters, table, and footer each in separate floating cards.

### 5.8 Dialogs

Use native semantic dialog behavior.

- Width: 480px standard, 640px for scrape confirmation.
- Clear title, consequence, saved/not-saved statement, and actions.
- Primary action on the right at desktop; stacked at mobile.
- Initial focus on the safest meaningful control.
- Escape closes only when no destructive operation is already executing.

## 6. Page specifications

### 6.1 Jobs

Header:

```text
JOBS                                            [Scrape jobs]
Shortlist roles worth your time.                Sources: FreeHire, LinkedIn · Ready
```

Order:

1. page heading and source readiness;
2. summary counter strip;
3. filters;
4. checked-row action bar when needed;
5. six-column table;
6. pagination only if real usage requires it.

Bulk action bar:

```text
3 checked                 [Select jobs] [Unselect] [Archive] [Clear]
```

It is inserted above the table and does not float over content.

#### Job detail

Use a two-column layout at `≥1100px`:

- Main `minmax(0, 2fr)`: posting and relevant workflow section.
- Aside `320px`: fit assessment, stage, dates, and actions.

Title block:

```text
Northstar Labs
Senior Backend Engineer
Jakarta / Remote · FreeHire · First seen 12 Aug
```

Sections:

- Fit assessment
- Job posting
- Documents
- Application record
- Follow-up
- Personal notes

Only stage-relevant sections and actions are emphasized. Other persisted sections may remain readable but collapsed.

### 6.2 Scrape confirmation

A 640px dialog or dedicated page overlay.

Summary is formatted as a definition list, not cards:

```text
PROFILE       Ready · reviewed 12 Aug
CRITERIA      Backend, Platform · Remote/APAC
SOURCE        FreeHire
MODEL         Google / Gemini 2.5 Pro
PASSING RULE  Score > 60
LIMIT         20 jobs
```

Footer:

```text
[Edit Profile & Criteria] [Open Settings]        [Cancel] [Start scrape]
```

Missing prerequisites appear as a compact error list above the footer. Start remains disabled.

### 6.3 Applications

Applications is a visual workflow board, not a second Jobs table.

Header:

```text
APPLICATIONS                          [Generate 2 selected]
Documents, approvals, and manual submission.
```

#### Kanban structure

Use six fixed lanes from left to right:

```text
SELECTED → DRAFTING → READY → APPLIED → INTERVIEW → OUTCOMES
```

- Standard lane width: `288px`.
- Lane gap: `12px`.
- Board has one intentional horizontal scroller.
- Lane backgrounds remain flat `surface-subtle`, with an ink top rule.
- Lane headers remain visually consistent at the top of each lane; they are not sticky because the page-level utility header already occupies the sticky layer.
- Header contains stage name, count, and a concise stage responsibility.
- Outcomes visually separates Offer and Rejected with semantic status marks inside one lane.
- Empty lanes remain visible as compact ruled drop-zone-shaped areas, but are not actual drop targets.

The Kanban is **not draggable**. It provides stage visibility and navigation, while consequential transitions still happen through explicit actions and confirmation dialogs. Do not add drag handles, hover lift, grab cursors, or optimistic movement between lanes.

#### Application card anatomy

```text
┌──────────────────────────────┐
│ □  NORTHSTAR LABS       88   │
│    Backend Engineer          │
│                              │
│ CV      Verified             │
│ LETTER  Verified             │
│ REVIEW  Needs review         │
│                              │
│ [Review documents]           │
└──────────────────────────────┘
```

- Cards use `surface`, a 1px ruled border, `4px` radius, and no default shadow.
- Company is an uppercase compact label; role is the primary card title.
- Score is top-right with tabular numerals.
- Metadata uses two-column definition rows, not badge clusters.
- Only Selected cards show a checkbox for sequential generation.
- Every card has one stage-appropriate primary action; secondary details open by clicking company/role.
- Failure state uses a danger-soft rule and preserves the failed-step text.
- Follow-up due state uses a small amber text line, not a notification badge.

Filters remain above the board. A compact board key explains that cards move only after explicit actions.

On narrow screens, retain the same horizontal lane sequence. Snap each lane near the viewport edge with `scroll-snap-align: start`; do not collapse all stages into one vertical feed.

#### Document review

Use a split workspace at desktop:

```text
┌───────────────────────────────┬────────────────────────────┐
│ Native PDF preview / open     │ Verification              │
│                               │ ✓ Compiled                 │
│ Tabs: CV | Cover letter       │ ✓ 2 pages                  │
│                               │ ✓ Text extracted           │
│                               │ ✓ Contact details          │
│                               │                            │
│                               │ Version history            │
└───────────────────────────────┴────────────────────────────┘
```

Action footer:

```text
[Open source] [Reject draft] [Regenerate]          [Approve documents]
```

Approval confirmation explicitly states that the job will become Ready. Verification success never visually implies approval.

### 6.4 Mark as Applied

Use a proper form dialog, never chained browser prompts.

Fields:

- Submission date, required, default today.
- Channel or portal, optional.
- Notes, optional.

Confirmation copy:

> This records an application you already submitted outside the dashboard. It does not submit anything for you.

Action: **Confirm Applied**.

### 6.5 Interview

Use a master-detail workspace.

Desktop:

- left `300px`: eligible jobs, search, Applied/Interview filter;
- right: selected job context and chat.

Chat avoids generic assistant bubbles:

- Pi question: full-width prompt block with `INTERVIEWER` label and dark rule.
- User answer: surface-subtle block with `YOUR ANSWER` label.
- Feedback: separate ruled section labelled `FEEDBACK`, with Strength / Tighten / Better framing.

Composer is anchored below the history but not permanently fixed over content.

Context strip above chat:

```text
NORTHSTAR LABS / BACKEND ENGINEER
Applied · CV verified · Focus: System design
```

Interview notes live in a separate right-side or collapsible panel. They do not appear as chat messages.

### 6.6 Profile & Criteria

Use two clearly separate save boundaries.

Desktop:

- top tabs or segmented navigation: `Profile` and `Search Criteria`;
- each section has its own Save and Discard actions;
- dirty state appears as `UNSAVED` beside the section title;
- a sticky local action footer is allowed for long profile content.

#### Professional profile editor

The Profile tab is a structured professional-profile editor inspired by the clarity of established career networks, without copying their branding or social features. It is not a Markdown editor.

At the top, show a compact profile preview:

```text
┌──────────────────────────────────────────────────────────┐
│ CN  Candidate Name                                      │
│     Senior Backend & Platform Engineer                  │
│     Jakarta, Indonesia · person@example.test            │
│     Open to remote APAC roles                           │
└──────────────────────────────────────────────────────────┘
```

- Initials avatar is optional and purely structural; no photo upload is required for MVP.
- Preview is generated only from saved/current field values and visibly marked `Preview`.
- Do not add follower counts, connection counts, feeds, endorsements, or social posting.

Editor sections appear in this order:

1. **Basic information** — first name, last name, headline, email, phone, city/region, country.
2. **Links** — website, LinkedIn URL, GitHub URL.
3. **About** — professional summary with character guidance, not AI rewrite controls.
4. **Experience** — repeatable entries.
5. **Education** — repeatable entries.
6. **Skills** — structured skill tokens with reorder and remove controls.
7. **Certifications**.
8. **Projects & awards**.
9. **Languages**.
10. **Work preferences** — authorization, relocation, remote preference, target roles, deal-breakers.

#### Section anatomy

Each section uses one ruled container:

```text
EXPERIENCE                                      [+ Add position]
────────────────────────────────────────────────────────────
Senior Backend Engineer · Example Company       [Edit]
Jan 2023 — Present · Jakarta / Remote
Factual responsibilities and measured outcomes…
────────────────────────────────────────────────────────────
Platform Engineer · Previous Company            [Edit]
Jun 2020 — Dec 2022
…
```

- Section heading and Add action share one line.
- Saved entries are readable summaries first; fields open inline or in a focused dialog only when editing.
- Add and Edit use the same field contract.
- Reordering uses explicit Move up / Move down controls in MVP, not inaccessible drag-only ordering.
- Remove appears inside edit mode and requires confirmation for saved entries.
- Dates use month/year selects and a `I currently work here` checkbox.
- Descriptions accept plain text with line breaks and preserve factual user wording.

#### Exact provider preview

A persistent aside or toolbar action opens **Provider context preview**. It serializes the current structured profile into the exact text/JSON shape sent to Pi, with unsaved values clearly identified. This is a read-only preview; it is not a second editor.

Search Criteria remains a separate structured form with its own save boundary and visible inline validation.

### 6.7 Settings

Settings is a calm system sheet, not a dashboard.

Sections separated by horizontal rules:

1. AI provider
2. Search
3. Documents

Each section has one concise status line.

Provider/model should use selects populated from runtime where possible, not unconstrained text fields.

Connection test result appears inline:

```text
● Connected · Google / Gemini 2.5 Pro · tested just now
```

Document tools use a compact checklist:

```text
lualatex     Available
xelatex      Available
pdfinfo      Available
pdftotext    Missing — install Poppler
```

Credentials are never represented as editable secret fields.

## 7. States

### Loading

- Initial page: retain shell and show 3–5 restrained row placeholders.
- Table refresh: keep existing rows with a small `Refreshing…` label; do not blank the table.
- Button action: label changes to present participle (`Saving…`, `Testing…`).
- Long AI work moves to the global run strip.

### Success

- Local save: inline `Saved just now` beside section title.
- Long operation: result panel with summary and one primary next link.
- Avoid celebratory confetti or oversized check illustrations.

### Empty

Empty states are left-aligned inside a ruled panel.

Structure:

```text
NO JOBS YET
Scrape jobs after your profile and criteria are ready.
[Scrape jobs]
```

One next action only. No decorative illustration.

### Zero filtered results

```text
NO MATCHES
No jobs match these filters. [Clear filters]
```

### Error

Use danger-soft panel with:

- plain-language heading;
- what was saved;
- what was not saved;
- Retry when safe;
- Settings link when provider-related.

Never show prompts, credentials, raw provider bodies, compiler logs, or stack traces.

### Unsaved

- `UNSAVED` label near the section title.
- Save action gains signal treatment.
- Discard remains secondary and requires confirmation if work is substantial.
- Browser/route leaving shows a single discard-or-stay dialog.

## 8. Content rules

Use direct operational language.

Prefer:

- “Generate 3 applications”
- “Documents need review”
- “No jobs match these filters”
- “Nothing was imported”
- “Applied manually on 12 Aug”

Avoid:

- “Unlock your career potential”
- “Let AI supercharge your journey”
- “Insights” when the content is a fit explanation
- “Magic” or “smart” labels
- “Done!” without saying what changed

Buttons begin with verbs. Statuses are nouns or past-tense results.

## 9. Accessibility

Required:

- WCAG AA text contrast;
- complete keyboard navigation;
- skip link to main content;
- one H1 per route;
- table headers use proper scope;
- selected rows communicate `aria-selected` or checked state;
- status changes announced through a polite live region;
- errors linked to their fields;
- dialogs trap focus and restore it when closed;
- external links state they open in a new tab when context is not obvious;
- icons have accessible names or are hidden when decorative;
- stage and verification state never rely on color alone;
- reduced-motion support.

Focus treatment:

```css
:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
```

## 10. Responsive acceptance

### ≥ 1200px

- full rail;
- full Jobs table visible without horizontal scrolling at 1440px viewport;
- job detail and review workspace may use split layouts.

### 760–1199px

- rail may remain compact or become top navigation depending on available width;
- filters wrap to two rows;
- split details may stack;
- summary strip scrolls horizontally.

### < 760px

- top bar + navigation sheet;
- page actions stack below titles;
- touch targets ≥44px;
- forms single column;
- tables retain required columns via horizontal scroll;
- dialogs become edge-to-edge sheets with 16px inset;
- no sideways page overflow outside intentional table scrollers.

## 11. Implementation guidance

Use the existing React/Vite stack and plain CSS first.

Recommended component boundaries:

```text
AppShell
├── ProductRail
├── UtilityHeader
├── GlobalRunStrip
└── RouteOutlet

JobsPage
├── PageHeading
├── StageSummaryStrip
├── JobFilters
├── BulkActionBar
└── JobsTable

JobDetailPage
├── JobHeading
├── WorkflowSections
├── FitAssessment
└── JobActionPanel

ApplicationsPage
├── ApplicationFilters
├── ApplicationBoard
│   ├── ApplicationLane
│   └── ApplicationCard
└── DocumentReview

InterviewPage
ProfileCriteriaPage
SettingsPage
```

No UI framework is required for MVP. Add a component library only if repeated accessible primitives become expensive to maintain. Native `<dialog>`, semantic tables, CSS grid, and React state are sufficient for the first implementation.

Do not port the current single component by adding more conditionals. Split by route and meaningful product surface.

### Structured-profile persistence migration

The structured Profile UI is backed by the canonical `profile.json` object. The older `profile.md` file is preserved unchanged as a legacy backup/import source and is not a second editable profile.

Recommended migration:

```text
data/profile.json       canonical structured profile
GET /api/profile        returns the structured profile object
PUT /api/profile        validates and stores the full structured object
GET /api/profile/export returns the deterministic provider-context serialization
```

Use a versioned strict schema with stable entry IDs and ordered arrays. On first run after upgrade:

1. preserve the existing `profile.md` unchanged as a backup;
2. expose its content in a one-time legacy-import panel;
3. require the user to map/review facts into structured fields;
4. never ask Pi to infer or silently migrate profile facts;
5. write `profile.json` only after explicit review and save.

Pi workflows should consume one deterministic serializer from the structured object. Do not maintain independently editable Markdown and JSON profiles, because they will drift.

## 12. Visual acceptance checklist

### Shell

- [ ] Five primary destinations are always directly reachable.
- [ ] Active destination is visually unambiguous.
- [ ] Global run state persists across page navigation.
- [ ] No page-specific action is misplaced in global utility chrome.

### Jobs

- [ ] Six required columns remain visible/present.
- [ ] Summary is one compact ruled strip, not a KPI card grid.
- [ ] Filters are legible and Clear filters is explicit.
- [ ] Checked rows and Selected workflow stage are visually distinct concepts.
- [ ] Selected rows use both checkbox state and row treatment.

### Applications

- [ ] Six fixed Kanban lanes communicate the stage order from Selected through Outcomes.
- [ ] Cards are never draggable; stage transitions remain explicit actions.
- [ ] Lane and card counts are visible without decorative KPI cards.
- [ ] Verification and approval are visibly different states.
- [ ] Document source and PDF links are obvious but secondary to review.
- [ ] Batch generation count and progress are explicit.
- [ ] Mark Applied states that submission remains external/manual.

### Interview

- [ ] Interviewer, user answer, and feedback have distinct labelled structures.
- [ ] Notes are separate from chat.
- [ ] Active job context remains visible.

### Forms and settings

- [ ] Profile uses structured professional fields rather than a raw Markdown editor.
- [ ] Experience, education, skills, certifications, projects, awards, and languages support repeatable entries.
- [ ] Profile and criteria have independent Save/Discard boundaries.
- [ ] Dirty state is visible.
- [ ] Validation appears beside the relevant field.
- [ ] Credentials are never accepted or displayed.

### Quality bar

- [ ] No gradients or glass effects.
- [ ] No decorative metric cards.
- [ ] No unnecessary icons or pills.
- [ ] No nested card-on-card layout.
- [ ] All loading, empty, success, error, and disabled states are designed.
- [ ] Primary paths work with keyboard only.
- [ ] Desktop and mobile screenshots have been visually inspected.

## 13. Prototype-data notice

The companion prototype uses clearly fictional company and role data solely to demonstrate layout and interaction states. It is not user data and must not be copied into production persistence.

## 14. Changelog

### 1.1

- Replaced the Applications list with a fixed-lane, non-draggable Kanban board.
- Replaced the Markdown profile editor with a structured professional-profile field system.
- Added responsive lane behavior and repeatable profile-entry anatomy.

### 1.0

- Established the Tracker visual direction.
- Defined visual tokens, shell, responsive behavior, components, page composition, and state patterns.
- Added anti-slop constraints and visual acceptance criteria.
- Locked one canonical detail surface and global run-strip presentation.
