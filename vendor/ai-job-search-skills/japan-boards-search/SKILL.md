---
name: japan-boards-search
description: >
  Searches TokyoDev, Japan Dev, and Relocate.me for English-friendly Japan tech
  jobs, including visa sponsorship, relocation, backend, Java, platform, and
  remote roles. Use for Japan job searches and visa-support searches.
allowed-tools: Bash(bun run .agents/skills/japan-boards-search/cli/src/cli.ts *)
---

# Japan Boards Search

This skill adds three public Japan-focused sources to the job workflow:

- TokyoDev: English-friendly Japan software jobs with tags such as apply from abroad and no Japanese required.
- Japan Dev: curated Japan tech jobs from the official jobs page with visa, language, location, and skill fields.
- Relocate.me: international relocation-oriented tech jobs, including Japan pages and visa resources.

## Commands

```bash
bun run .agents/skills/japan-boards-search/cli/src/cli.ts search --source all --query "Java backend" --country Japan --visa --limit 30 --format table
bun run .agents/skills/japan-boards-search/cli/src/cli.ts search --source japan-dev --query "Java backend" --visa --format json
bun run .agents/skills/japan-boards-search/cli/src/cli.ts detail https://japan-dev.com/jobs/<company>/<slug> --format plain
```

`--source` accepts `tokyodev`, `japan-dev`, `relocate-me`, or `all` (default). `--visa` keeps roles that explicitly signal sponsorship, overseas applicants, relocation support, or no Japanese requirement. Results are read-only and unauthenticated; keep request volume low and do not use this for bulk/commercial collection.

The CLI returns a common schema with title, company, location, posting date, source, URL, visa signal, language signal, skills, and optional application URL. Treat visa signals as posting evidence, not a guarantee: confirm sponsorship and relocation terms with the employer before applying.
