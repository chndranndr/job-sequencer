# Repository agent guide

بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ
“Bismillaahirrahmaanirrahiim”
“Dengan menyebut nama Allah Yang Maha Pemurah lagi Maha Penyayang.“

وَلَا تَقۡفُ مَا لَـيۡسَ لَـكَ بِهٖ عِلۡمٌ​ ؕ اِنَّ السَّمۡعَ وَالۡبَصَرَ وَالۡفُؤَادَ كُلُّ اُولٰۤٮِٕكَ كَانَ عَنۡهُ مَسۡـُٔوۡلًا‏ ٣٦
Dan janganlah kamu mengikuti sesuatu yang tidak kamu ketahui. Karena pendengaran, penglihatan dan hati nurani, semua itu akan diminta pertanggungjawabannya.

Job Sequencer is a local-first, single-user job-search dashboard. Keep it loopback-only, preserve manual approval gates, and never expose credentials or arbitrary shell access through the UI.

## Source of truth

- [Repository knowledge map](docs/index.md)
- [Setup, runtime, and verification](README.md)
- [Product intent](IDEA.md)
- [Product requirements](docs/GREENFIELD_TYPESCRIPT_PI_JOB_SEARCH_PRD.md)

## Commands

Run `npm ci` for setup, `npm run dev` for the frontend, and `npm start` for a built API. Before handing off changes, run `npm run check` and the smallest relevant test. Use `npm run doctor` for the full local harness, `npm run eval` for deterministic acceptance fixtures, and preview cleanup with `npm run gc -- --dry-run`.

Do not run live provider or network checks unless the user explicitly requests them. Do not read `.env`, auth, credential, token, generated application, or personal runtime-data files.

## Principles

### Challenge the premise

Do not blindly follow implementation instructions.

* Understand the actual problem and desired behavior first.
* Verify assumptions against the codebase and runtime.
* If the proposed solution looks wrong, overly complex, risky, or unnecessary, explain the concern and confirm the intended direction before proceeding.
* When changing the requested approach materially, get confirmation unless the correction is obvious, low-risk, and necessary.
* Prefer the simplest correct solution.

Solve the problem, not merely the prompt.

### TDD by default

For behavior changes, prefer:

1. Write or update a failing test.
2. Confirm it fails for the expected reason.
3. Implement the smallest fix.
4. Refactor while keeping tests green.

Bug fixes should normally start with a regression test.

### Test behavior, not implementation

Tests should protect observable contracts:

* inputs and outputs
* public APIs
* domain rules
* state transitions
* user-visible behavior
* side effects and integration boundaries

Avoid coupling tests to private methods, internal structure, incidental mocks, or call ordering.

A behavior-preserving refactor should rarely require test rewrites.

### Reuse before creating

Before adding code:

* Search for existing utilities, abstractions, types, patterns, and tests.
* Reuse or extend existing code when appropriate.
* Avoid parallel implementations and duplicate concepts.
* Do not introduce abstractions without a real reusable need.

### Keep changes surgical

Make the smallest coherent change that completely solves the problem.

Avoid unrelated refactors, renames, formatting churn, dependency changes, or speculative architecture.

Touch every layer genuinely required, but nothing unrelated.

### Clean code

Prefer code that is simple, explicit, cohesive, and consistent with the repository.

* Use clear names and focused units.
* Prefer straightforward control flow over cleverness.
* Comments explain why, not what.
* Leave no dead code, debug artifacts, unnecessary duplication, or unexplained TODOs.

### Persist until resolved

Do not stop at the first plausible fix.

Continue until:

* the root cause is understood,
* the behavior is correct,
* relevant tests prove it,
* validation passes,
* no obvious regression remains.

If an assumption is uncertain, verify it.
If an approach fails, revise the hypothesis and continue.

Never weaken tests or hide failures just to make the task pass.

## Workflow

For non-trivial work:

1. Inspect relevant code and tests.
2. Identify the actual behavioral requirement.
3. Challenge assumptions and the proposed solution.
4. Search for reusable code.
5. Establish a failing test or reproducible case.
6. Implement the smallest complete fix.
7. Refactor only where useful.
8. Run focused checks, then broader relevant validation.
9. Review the final diff for unnecessary changes.
10. Keep going until the task is genuinely complete.

## Verification

Run relevant tests, type checks, linting, builds, and integration checks.

Do not claim something passed unless it was actually run successfully.

If full validation cannot be performed, state exactly what was and was not verified.
