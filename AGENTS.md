# AGENTS.md — muckers

Rules for any agent (or person) changing this repo. The shape and most of the wording come from Cliff Hall's
`modelcontextprotocol/inspector` AGENTS.md, as the maintainer ruled on it on 2026-11-14. Where his way and ours
differ, **the source's way stands until there is a reason to depart**; every departure below says why.

`CLAUDE.md` contains only `@./AGENTS.md`. Keep one copy of these rules: two copies are strictly worse than one,
because the stale copy is indistinguishable from the live one.

## What this is

A public Cloudflare Worker (D1 + KV + Workers AI) that anyone deploys into their own account with the Deploy
button. Two endpoint families plus a cron: `digest` (a daily brief synthesized from configured sources and
delivered to configured targets) and `organizer` (a rule-of-three detector over the digest archive). Three file
primitives ship alongside: `templates/STANDING_RULES.md`, `templates/AGENDA.md`, `skills/dual-mode/`. `README.md`
is the user-facing description; `HISTORY.md`, `PRINCIPLES.md` and `ARCHITECTURE.md` explain the why.

## The PACK_TOKEN gate (read this before touching `src/index.ts` or `src/common.ts`)

Every route except `GET /`, `GET /digest/schema`, `GET /organizer/schema` and `OPTIONS` requires `X-Pack-Token`.
The worker answers 503 when `PACK_TOKEN` is missing, shorter than 32 characters or a `CHANGE-ME` placeholder, and
compares tokens in constant time through `crypto.subtle.timingSafeEqual`, failing closed where that is absent.

- **Never weaken the gate.** No new public route, no fallback comparison, no relaxed length or placeholder check,
  no route matched before the gate. Changing it is a decision made explicitly in the issue; a refactor, a lint fix
  or a review suggestion is never a reason.
- **`test/gate.test.ts` cases 1–28 were written by Codex and stay as written** (expectations and inputs). Only the
  harness around them may change. Add a case when the gate changes; never delete or loosen one.
- Repairs are recorded in `KINTSUGI.md` (append-only), with a `kintsugi:` comment at the site and a `Kintsugi:`
  commit trailer, as that file describes.

## Project structure

- `src/index.ts` — routing, the gate, the service-info page, the cron entry.
- `src/common.ts` — `Env`, response helpers, the token predicates.
- `src/digest.ts` — source readers, synthesis (Anthropic or Workers AI), delivery, run bookkeeping.
- `src/organizer.ts` — scanner, proposal upsert, proposal listing and lifecycle.
- `migrations/` — D1 schema. `wrangler.toml` — bindings, cron, required secret.
- `test/` — Vitest suites (`*.test.ts`) and `test/helpers/fakes.ts` (fake D1/KV/AI and a fetch stub).
- `scripts/` — gate tooling.

## Development setup

- `bun install`. Bun runs this repo's own scripts (`bun run <script>`); if you run one of Cliff Hall's own tools
  or procedures, use his runner (`npx`) as he documents it.
- Tests run on Vitest with `@vitest/coverage-v8`, Cliff's choice, because Bun's coverage cannot measure branches
  or enforce a per-file bar.
- No Cloudflare account, secret or network is needed for any gate step. Tests stub `fetch`; nothing reaches
  GitHub, Discord, Anthropic or ntfy.

## Issue-driven work style

Linear is the board. The rules:

- **Before starting work, find the issue.** Every change has one. Before filing a new one, search for a match:
  **never create a duplicate**.
- **`Todo` means the maintainer approved it, and only the maintainer moves an issue into `Todo`.** `Backlog` is
  filed, not approved. Start work only on an approved issue.
- **Label by type: exactly one of `bug` / `enhancement` / `documentation` / `chore` / `question`.** Work run through
  this process also carries the factory label (not named yet; until it is, say "factory method" in the PR).
- **`Done` means the work shipped** (its PR merged) and was verified. Anything else is canceled, not done.
- **When work begins**, assign yourself, set the issue In Progress, and create the branch **in a new git worktree**,
  never by switching branches in a checkout another session may share.
- **When work is complete**, run `bun run format` then `bun run local:gate`, **sign off every commit**
  (`git commit -s`), open a PR with **the issue reference as the body's first line**, and set the issue In Review.
- **After opening a PR, run a Codex review loop** (`codex exec --sandbox read-only`), unprompted. Stop on the
  **first** clean round (no confirming round "just to be sure"). **Weigh each finding against the issue the PR
  closes and decline scope expansion.** Two failed rounds in a row: stop, leave the PR open, list the findings in
  it. (Departure: Cliff uses Copilot; the maintainer chose Codex as the off-lineage reviewer.)
- **If new tasks are discovered during development, file issues** rather than widening the PR.
- **Pace bulk GitHub writes: 1 s between requests, never in parallel**, under 80 a minute and 500 an hour.
- **A security issue stays private until its fix is ready**; accepting or publishing an advisory is outward-facing
  and stays human-gated, never automated.
- **This repo is public. Merging is the maintainer's act**, and nothing personal goes into a commit, PR or test
  (home paths, emails, names, tokens). Tests use synthetic data only.
- **Deploys are human-gated.** `bun run deploy` is run by whoever operates an instance, into their own account.
  No agent deploys, and no workflow deploys.

### Responding to code reviews

- Judge each suggestion against the issue the PR closes. Fix defects in what the PR added; decline, with a reason,
  what expands it; file an issue for anything worth doing on its own.
- Reply in each review comment's own thread (a rollup comment does not discharge it), then post a summary in
  addition.

## Always test new or modified code

- **Ensure all code has corresponding tests. Every file under `src/` must clear ≥ 90 on all four dimensions
  (lines, statements, functions, branches), per file**, enforced by `vitest.config.ts` and therefore by
  `bun run test`, `bun run local:gate` and CI. This is the source's bar (Cliff's inspector). **Never lower the
  threshold to pass.**
- Measured on 2026-11-16 (statements / branches / functions / lines): `src/common.ts` 100 / 100 / 100 / 100,
  `src/index.ts` 100 / 100 / 100 / 100, `src/digest.ts` 100 / 98.83 / 100 / 100, `src/organizer.ts`
  100 / 100 / 100 / 100. No coverage exclusions.
- Coverage exclusions, if one is ever needed, are exact paths, one per entry, each with a reason and a follow-up
  issue; never a glob that could hide a new file.
- **A genuinely-unreachable branch is annotated at the source** (`/* v8 ignore next -- <reason> */`), never waved
  through by lowering the gate.
- **A gate must show how much it checked.** `scripts/verify-gate-scope.ts` runs after the tests and fails if a
  tracked `.ts` file is in no tsconfig project or a `src/` file is missing from the coverage summary. Fix that by
  fixing the globs, never by excusing the file.
- Test files are `test/**/*.test.ts`; a file named otherwise is silently not run.
- A test that races is fixed with fake timers or an awaited condition, never with a longer timeout.

## Mandatory pre-push gate

- **ALWAYS run `bun run format` before committing.**
- **`bun run local:gate` is the mandatory pre-push command.** It runs every check CI runs: `format:check`,
  `lint`, `typecheck` (both tsconfig projects) and `test` (Vitest with the coverage bar, then the gate-scope
  check). A green run here means every check CI applies has already passed on your machine.
- There is deliberately no `ci` script (the name collides with the package-manager built-in). CI runs the four
  stages directly and never calls a `local:*` script.
- Departures, each for a stated reason: no gate lease (the gate takes seconds and binds no ports); no DCO check
  job (adding the required-check ruleset is a repository setting, the maintainer's to change); no smoke stage
  (there is no built artifact to drive without a Cloudflare account).

## Waiting on long-running work

**When you are waiting for something to finish, arm a notifier and stop. Never spend turns polling.** For state
the harness cannot observe (a CI run, a remote review), poll inside one backgrounded loop that exits when the
condition holds, at 30 s or more. **If a notifier is already armed, that settles it: wait.**

## Build output is never a gate target

**No gate (lint, format or typecheck) may read generated output.** Out of scope: `node_modules/`, `.wrangler/`,
`coverage/`, `dist/`, `bun.lock`. Each scope states it: `globalIgnores` in `eslint.config.js`, `.prettierignore`,
and tsconfig `include` lists that name source directories. **When a build starts writing to a new location, add
it to the ignore lists in the same change.** Never widen an ignore to silence a finding in first-party code.
Markdown is also outside the format scope: prettier rewrites prose.

## Lint has no warning tier

**`lint` runs with `--max-warnings 0`, so a warning fails the gate exactly as an error does.** Rules: ESLint
recommended, typescript-eslint recommended, and `@typescript-eslint/no-floating-promises` at `error`.

- **Do not silence a finding to satisfy the gate.** A warning is a defect to fix. If a rule genuinely must be
  waived on one line, use its inline disable comment **with a one-line justification**. Dropping a rule or
  widening an ignore to make `lint` pass is not a fix.
- Prefer `error` for any rule you intend to enforce.

## TypeScript

- TypeScript for all code. Never `any`: type D1 rows, narrow JSON at the boundary from `unknown`.
- No floating promises: `await` them, or `void` them with a comment saying why.
- Every new file starts with a header comment saying what it is for and why.
- A rule about what the code does is asserted at runtime in a test, not read out of the source.
