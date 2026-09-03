# Repository agent guide

Job Sequencer is a local-first, single-user job-search dashboard. Keep it loopback-only, preserve manual approval gates, and never expose credentials or arbitrary shell access through the UI.

## Source of truth

- [Repository knowledge map](docs/index.md)
- [Setup, runtime, and verification](README.md)
- [Product intent](IDEA.md)
- [Product requirements](docs/GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md)

## Commands

Run `npm ci` for setup, `npm run dev` for the frontend, and `npm start` for a built API. Before handing off changes, run `npm run check` and the smallest relevant test. Use `npm run doctor` for the full local harness, `npm run eval` for deterministic acceptance fixtures, and preview cleanup with `npm run gc -- --dry-run`.

Do not run live provider or network checks unless the user explicitly requests them. Do not read `.env`, auth, credential, token, generated application, or personal runtime-data files.
