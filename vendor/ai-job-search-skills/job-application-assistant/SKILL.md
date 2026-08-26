---
name: job-application-assistant
description: >
  Assists with job applications: evaluating job postings, tailoring CVs, writing cover letters,
  and preparing for interviews. Triggers on keywords like: job posting, job application, CV,
  cover letter, resume, interview prep, job fit, career, application, apply, ansøgning, stilling
allowed-tools: Read, Glob, Grep, WebFetch, WebSearch, Edit, Write, AskUserQuestion
---

# Job Application Assistant

---

## Workflow

When the local dashboard has been used, read `dashboard_settings.json` as an optional local override for search criteria and candidate profile fields. Treat `AGENTS.md` and the canonical profile skill files as the baseline; use non-empty dashboard profile fields to reflect the user's latest manual corrections, without committing or exposing the settings file.

When the user provides a job posting (URL or text), follow this workflow:

Run this workflow directly in the current Codex chat. Do not spawn `codex` or require the terminal wrapper. The terminal wrapper is only a compatibility launcher for users running workflows from PowerShell.

### Step 1: Research & Evaluate Fit
- Fetch the job posting content (use WebFetch for URLs)
- Analyze the posting for required competencies, keywords, and priorities
- Research the company (website, LinkedIn, mission, recent news)
- Score the posting against the candidate's profile using the framework in `04-job-evaluation.md`
- Present the evaluation table and verdict
- Suggest whether the candidate should call the employer before applying (see `04-job-evaluation.md` for guidance)
- Stop and ask the user if they want to proceed with an application before drafting any CV or cover letter files

### Step 2: Select or Tailor CV
- Read `05-cv-templates.md`, then select the closest verified canonical variant from `cv/variants/`
- Copy it to `cv/source/main_<company>_<role>.tex` for the application; never modify the canonical source during an application
- Reuse the copied CV unchanged when the role has the same positioning and its supported keywords are already covered
- Tailor only when the role materially changes the positioning, required skills, evidence emphasis, language, or seniority. Adjust only the necessary profile statement, skills, experience bullets, or section order.

### Step 3: Write Cover Letter
- Follow the writing style rules in `03-writing-style.md` (critical: no em-dashes, no cliches)
- Follow the template structure in `06-cover-letter-templates.md`
- Create `cover_letters/source/cover_<company>_<role>.tex`
- Ensure the letter connects specific experience to the role requirements

### Step 4: Interview Preparation
- Follow the framework in `07-interview-prep.md`
- Prepare STAR-format answers for likely questions
- Identify role-specific talking points
- Draft questions the candidate should ask the interviewer

---

## Reference Files

| File | Purpose |
|------|---------|
| `01-candidate-profile.md` | Education, experience, skills, publications, awards |
| `02-behavioral-profile.md` | Behavioral assessment, strengths, ideal environments |
| `03-writing-style.md` | Tone, structure, do's and don'ts |
| `04-job-evaluation.md` | Scoring framework for job fit |
| `05-cv-templates.md` | LaTeX CV structure and tailoring rules |
| `06-cover-letter-templates.md` | LaTeX cover letter structure and tailoring rules |
| `07-interview-prep.md` | STAR examples, tough questions, roleplay guidelines |

---

## Quick Commands

The user may also ask for individual steps without the full workflow:
- "Evaluate this job posting" - Step 1 only
- "Write a CV for [company]" - Step 2 only
- "Write a cover letter for [role] at [company]" - Step 3 only
- "Help me prepare for an interview at [company]" - Step 4 only
- "What jobs should I look for?" - Career strategy discussion using profile + evaluation framework
