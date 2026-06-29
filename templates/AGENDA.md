# Agenda — cross-session ticket store

> The ticket primitive that makes deep-flow guarantees real instead of theater. Items live here across sessions; the agent surfaces them at the right cadence, not all at once. Below-high-tier tickets don't pull the operator out of deep state.
>
> Priority tiers:
> - **critical** — time-sensitive, blocking active work
> - **high** — high-leverage, composes with active work
> - **medium** — substantial decisions, no compose-urgency
> - **low** — deferred, no momentum
> - **parked** — intentionally on hold, scope or context not ready
>
> Status: `open` | `closed` | `parked`. Closed tickets stay in the file as receipt history. Don't delete; let the file be a real record of what was decided when.

---

## Open tickets

### T-001 · Example ticket — first thing to triage · MEDIUM
**Created:** YYYY-MM-DD · **Last touched:** YYYY-MM-DD
**Compose:** what other active work this composes with — links / references
**What's blocked:** what cannot move forward until this resolves
**What input needed:** what the principal needs to decide / provide
**Default if Margin (your agent) picks:** the most defensible default the agent would pick if not given input. Surface the default so the principal can redirect rather than re-derive.

---

## Closed tickets (receipt history)

> Add closed tickets here on completion. Format: ticket id, title, closing date, one-line outcome.

---

## How to use this template

1. **Copy this file** to wherever your shared shuttle / project-tracking lives. Common path: `~/your-shuttle/AGENDA.md` or `~/.claude/PAI/AGENDA.md`.
2. **Number tickets sequentially** (T-001, T-002, ...) so they're easy to refer to in conversation.
3. **Each ticket carries the four fields**: compose / blocked / input-needed / default. The default field is critical — it lets the agent act on the agent's best-judgment when input doesn't arrive, instead of just waiting forever.
4. **Surface cadence rules**: critical/high tickets surface at the start of a session (or whenever explicitly asked); medium/low surface only when the principal asks "what am I losing track of." This is the deep-flow guarantee.

## Why this matters for one-session-as-manager operators

When you have ONE main agent managing all your projects, every interrupt from the agent costs deep-state. The temptation is to have the agent surface everything that needs attention — but that breaks the cognitive payload the manager-agent pattern depends on. AGENDA lets you defer ticket-surfacing to the right cadence. Below-high-tier items live here, the agent doesn't ping you about them mid-flow, you ask for them when you want them.

## Composes with

- `Workflows/DualMode.md` — when you're parallel-tracked, dual-mode ships reversible work + uses AGENDA as the queue of input-needed items to surface at exit
- `templates/STANDING_RULES.md` — the constitutional layer that says "surface below-high-tier tickets only when asked" lives there

## Where to learn more

The toolkit's `Workflows/InstallToolkit.md` walks the install for all five primitives. The AGENDA primitive on its own is useful; combined with dual-mode + digest it becomes the operational backbone of the one-session-as-manager pattern.
