---
name: scrape
description: >
  Searches live tech job portals for the candidate's configured target roles in local,
  remote, APAC, and selected international markets. Deduplicates across runs.
  Triggers on: job scrape, find jobs, search jobs, new jobs, job search, scrape jobs, /scrape
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(bun --version), Bash(bun run .agents/skills/*/cli/src/cli.ts *), WebFetch, WebSearch, Agent, AskUserQuestion
---

# Job Scraper

## How It Works

Search live job portals using targeted queries based on the candidate's verified backend, platform, cloud, fintech, and data/AI profile. Deduplicate against previously seen jobs and the application tracker, then present new matches with a quick fit assessment.

Default market:
- The candidate's configured local market and metro-area hybrid roles
- Remote roles in the candidate's configured country
- APAC remote roles
- Singapore, Australia, and Europe remote roles when work authorization and timezone look plausible
- Japan-focused English-friendly and visa/relocation roles from `japan-boards-search` when Japan is requested

Danish portal skills remain available as optional sources. Use them only when the user explicitly asks for Denmark or a query targets Denmark.

## Invocation

The user may say:
- "Find new jobs"
- "Scrape for jobs"
- "Any new positions?"
- "/scrape"

Optional arguments:
- A focus area, e.g. "/scrape fintech", "/scrape ai platform", or "/scrape remote"
- "broad" to run all search categories, e.g. "/scrape broad"

## Execution Steps

### Step 0: Load State

1. Read `job_scraper/seen_jobs.json`. If missing, create it as `{"seen": {}}`.
2. Read `job_search_tracker.csv` if it exists.
3. Read `search-queries.md` for the search strategy.

### Step 1: Search

By default, run the top 3 priority query categories from `search-queries.md`. If the user said "broad", run all categories. If the user specified a focus area, prioritize matching categories.

Use installed CLI tools first:
- Primary default: `freehire-search`
- Primary default: `linkedin-search`
- Japan-focused: `japan-boards-search` for TokyoDev, Japan Dev, and Relocate.me
- Optional Denmark-only: `jobbank-search`, `jobdanmark-search`, `jobindex-search`, `jobnet-search`

Check Bun availability:

```bash
bun --version
```

If Bun is unavailable, use live web search as fallback and report the fallback.

For each portal skill:
1. Read that portal's `SKILL.md`.
2. Use its documented command and flags. Do not guess flags.
3. Scope to the last 14 days where supported.
4. Cap results to roughly 20 per call.
5. Use `--format json` where available.

For Japan searches, also run:

```bash
bun run .agents/skills/japan-boards-search/cli/src/cli.ts search --source all --query "Java backend" --country Japan --visa --limit 30 --format json
```

The Japan board CLI is read-only personal research; visa signals must be confirmed with the employer.

### Step 2: Fetch & Parse

For promising results, retrieve enough detail to extract:
- job title
- company
- location/work mode
- posting date or deadline
- URL
- key requirements

Skip jobs that are closed, expired, already in `seen_jobs.json`, or already in `job_search_tracker.csv`.

### Step 3: Quick Fit Assessment

Use a fast signal, not the full application evaluation:
- **High**: Java/Spring Boot/backend/microservices/cloud/distributed systems match strongly.
- **Medium**: adjacent backend/platform/full-stack role or strong company fit with a stack gap.
- **Low**: major stack, domain, location, seniority, or authorization mismatch.

Flag before presenting:
- onsite outside the configured preferred area
- mandatory relocation
- unclear work authorization
- contract-only roles
- non-Java stack where Java is only optional

### Step 4: Deduplicate & Store

Add fetched jobs to `job_scraper/seen_jobs.json`:

```json
{
  "seen": {
    "<url_or_company_title_key>": {
      "title": "...",
      "company": "...",
      "location": "...",
      "url": "...",
      "first_seen": "YYYY-MM-DD",
      "posted_date": "...",
      "fit": "high/medium/low",
      "status": "new/skipped/evaluated/ranked/expired",
      "source": "...",
      "work_mode": "...",
      "match_score": 0,
      "skills": []
    }
  }
}
```

Only present postings that are new/open and not already applied.

### Step 5: Present Results

Present a table sorted by fit:

```markdown
## New Job Matches - YYYY-MM-DD

Found X new positions.

| # | Fit | Title | Company | Location | Date/Deadline | URL |
|---|-----|-------|---------|----------|---------------|-----|
```

For high-match jobs, add concise notes:
- why it matches the candidate's profile
- requirements to check
- red flags

Ask which posting should be evaluated in detail. If the run found many jobs, suggest ranking.

## Rules

- Never fabricate job postings.
- Respect deduplication.
- Default to the configured local market/remote/APAC.
- Use Danish portals only when explicitly relevant.
- Only present open positions.
- Prefer portal CLI tools over generic web search.
