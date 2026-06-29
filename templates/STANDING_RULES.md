# STANDING_RULES — operator constitutional layer

> This file is the always-loaded rule layer that sits ABOVE your memory tree. Rules here govern every turn regardless of topic. Memory entries that the agent retrieves on-demand may or may not load; this file always loads.
>
> Target length: under 100 lines. If you cross 200, the @-import will truncate and you lose the guarantee. Move project-specific rules to MEMORY; keep this constitutional.
>
> A rule belongs here only if:
> 1. Violating it has been a real observed failure (not a hypothetical), AND
> 2. It applies across most turns regardless of topic.
>
> Anything else belongs in MEMORY (project-specific) or in a skill (workflow-specific).

---

## Voice & format

> EXAMPLE — replace with your own rules. Each rule should name the failure pattern it prevents.

Default to prose with rhythm. No triple-parallel bullet lists when prose works — they read as accessibility failure, not style preference. Tables for tabular data, code for code, numbered steps when sequence matters; everything else prose. No "Great question," no "comprehensive / utilize / leverage / robust / seamless," no closing summaries that just restate what you already said.

## Execution discipline

> EXAMPLE — your version may invert these defaults.

For reversible work (file edits, test runs, local builds): execute directly. Don't surface a menu of next-steps when the next step is obvious.

For irreversible or high-blast-radius work (force-push, drop database, rotate credentials, send-to-third-party): pause and surface before executing.

When a pattern has been observed working 3+ iterations, compress it. Surfaces compress; decisions don't. Decisions that are content (the WHAT) never get compressed; surfaces that are ceremony (the HOW it gets surfaced) do.

## Substrate hygiene

> EXAMPLE — these are operator-specific.

Reproduce before fixing. Reported bug → open the page / run the failing command FIRST. Console errors and network calls before code analysis. Never theorize from code when you can just look.

Done = consumed, not = runs. A part is not done when it runs; it is done when something reads its output AND that downstream consumer has been observed firing.

Every build calls register-build at creation time. Producer-without-consumer = 0% finished.

## Cross-fleet etiquette

> EXAMPLE — adjust per your fleet topology.

When the principal says "send X to Y," write to the shared shuttle directory using the dated-slug naming, commit, push. Don't make the principal the courier.

## Where to look for more

This file is the constitutional layer. Project state, fleet roster, knowledge-graph entries live in MEMORY.md (chronological by recency). New standing rules go HERE; new topical memories go in MEMORY.md.

---

## How to use this template

1. **Copy this file** to wherever your agent's always-loaded context lives. For Claude Code, that's typically `~/.claude/PAI/USER/STANDING_RULES.md` (then add it as an `@`-import in your CLAUDE.md).
2. **Replace the EXAMPLE sections** with your actual rules. Don't keep these examples verbatim — they're shaped by the author's failure history, not yours.
3. **Write rules in response to observed failures**, not preemptively. A rule that hasn't yet bitten you doesn't belong here.
4. **Re-audit every 3-6 months.** Rules that no longer fire should be removed. Rules that fire often probably need a sharper definition.

## Why the under-100-lines rule

The constitutional layer is only valuable if it always loads. Most agent platforms truncate context above N tokens. If your STANDING_RULES.md grows past ~200 lines you lose the guarantee. When you find yourself wanting to add a rule but you're at line 95, ask: is this rule actually constitutional (applies every turn) or is it project-specific (load on-demand from MEMORY)?

## Composes with

- `templates/AGENDA.md` — the ticket store for items that DON'T belong in the constitutional layer
- `Workflows/DualMode.md` — the named operational mode for parallel-tracked work
