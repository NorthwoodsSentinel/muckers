# Dual Mode — primitive description

**Status:** Documented pattern, not a SKILL.md package. Adopt by reading this file + adding it to your agent's standing rules / behavior layer. Trigger phrasing and behavior contract are below.

---

## Trigger

The principal is in deep dialogue with another agent (a second AI, another instance, or a parallel-tracked surface). They're parallel-tracked, not paused — the other dialogue is the live work, your job is to make their bandwidth bigger, not compete for it. Trigger phrase is *"dual mode"* or any directive equivalent in shape (*"keep busy while I work with X"*, *"don't pull me out"*).

## Behavior during Dual Mode

- Ship every reversible artifact queued from prior conversations without asking
- Sweep stale substrate (orphan files, superseded memos, owed-but-released items)
- Read substrate for open threads, in-flight builds failing the "done = consumed" check, named-people commitments aging past their deadlines
- Identify decisions or hands-on actions queued for the principal
- Invoke your `ProjectManager`-equivalent (or whatever skill you have for cross-workstream status) for an inventory sweep

## Constraint

**ZERO cognitive load demand on the principal during the mode.** No mid-mode pings, no decision menus, no clarifying questions, no "want me to also..." Every reasonable call gets made autonomously. If a call has multiple defensible paths, pick one and document it as flexible.

## Exit

When the principal next directly addresses you. The exit response surfaces a CONSOLIDATED list of input-needed items at the top, with ship/clean/sweep work as supporting context. Don't bury the input-needed items in a wall of accomplishments — they're the load-bearing output.

## Exit close — deep-flow language is mandatory

A wall-of-text exit pulls the principal back out of deep state with the other surface precisely when they should be free to choose: re-engage you or stay with the other. Three structural requirements for the close:

**First**, the exit response names the wall-of-text explicitly — *"that's the sweep, here's what actually needs you,"* — so the principal can re-orient without having to scan the whole body.

**Second**, the close highlights only CRITICAL and HIGH priority items. Everything else gets ticketed into `AGENDA.md` (the cross-session ticket store) and surfaces at the right cadence later, not now. Three items in the close, not ten.

**Third**, the close assures the principal explicitly that everything is safe to leave. *"Go back to [the other surface]. Nothing will be lost. The agenda holds the rest until you want it."* — the assurance is the deep-flow signal that lets them stay in pattern-retrieval mode with the other surface instead of carrying agenda overhead in their head.

The `AGENDA.md` primitive (see `AGENDA.md` template) is the ticket store that makes "everything is safe to leave" a real promise, not theater. Tickets below high tier surface only when their cadence fires OR when the principal explicitly asks.

---

## Why this is a primitive description, not a SKILL.md

Dual Mode is a behavioral contract, not a discrete tool. There's no command to invoke, no API to call. You install it by:

1. Reading this file
2. Adding the trigger phrase and behavior contract to your agent's standing rules / system prompt / behavior layer (in PAI 5.0, this is `~/.claude/PAI/USER/STANDING_RULES.md`)
3. The agent recognizes the trigger phrase and adopts the behavior

If you want it as a discrete skill the agent invokes via a `Skill()` call, you'd wrap this contract in a SKILL.md inside a `skills/DualMode/` directory with a single workflow file. The pattern works either way; the primitive description above is the canonical content.

## Composes with

- **STANDING_RULES.md** — install the trigger phrase + behavior contract here as one of the agent's constitutional rules
- **AGENDA.md** — Dual Mode's exit-close assurance ("nothing will be lost") relies on AGENDA as the durable ticket store

License: Apache 2.0.
