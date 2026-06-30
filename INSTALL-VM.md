# INSTALL-VM.md — muckers on a Linux VM (Proxmox, vanilla, anything POSIX)

For users running muckers outside Cloudflare's runtime — own VM, own Proxmox host, own dedicated box. Companion to `INSTALL.md` (which covers the cleanest path: file-based primitives on top of Cloudflare Workers + Claude Code + PAI).

---

## TL;DR

muckers has five primitives. **Three are pure files that install in roughly 15 minutes on top of an existing Claude Code + PAI install** — no VM, no adapter, no model-cost question. They are the state-management half of the toolkit: STANDING_RULES.md, AGENDA.md, DualMode skill. Install those first via the steps in `INSTALL.md` — they ship the same on any host, including the VM you stood up.

The other two primitives — **digest** and **organizer** — are synthesis-output tools. They originally targeted Cloudflare Workers + AI Gateway. On your own VM, both run on Cloudflare's open-source `workerd` runtime + miniflare-style local SQLite/file bindings, plus a small AI-dispatch helper that lets you choose between the Anthropic API or a local Ollama model. Plan for those is **Phase 2** below.

The order matters. Install the file primitives first.

---

## Why install file primitives first, even if digest is what brought you here

A common entry-point assumption is that digest is the most approachable primitive — synthesis is concrete and visible, so it feels like the natural starting point. After running the full toolkit through real-use friction for a couple of months, the recommendation is the opposite: **the tax most users name is in state management, not synthesis.**

The three phrases that show up repeatedly in user-friction reports:

- **"guru syndrome"** — jumping between productivity systems, re-teaching each one your conventions
- **"chasing one for doing work"** — running after the productivity AI to make it cooperate instead of having work flow naturally
- **"journaling to prioritize"** — manually re-deriving what's important each session because last session's state didn't survive

Mapping each phrase to a primitive:

- **STANDING_RULES.md** addresses the guru syndrome. Corrections you give an agent land once, persist across all sessions, and the agent treats them as constitutional. You stop re-teaching the same lessons across new chats.
- **AGENDA.md** addresses the journaling-to-prioritize tax. Cross-session ticket store with priority tiers. Items survive sessions; you don't re-derive priorities; the system surfaces critical/high items at the right cadence without burying you in everything.
- **DualMode skill** addresses the chasing-one. Lets you parallel-track work with two agents at once — one keeps you in flow, the other handles cleanup/triage in the background and exits with only the items that need your input.

Digest is real value, and you'll likely want it once the state-management layer is wired. But digest is an output stage; the file primitives are the input stage. Adding faster output to a pipeline whose input is still manual produces less value than wiring the input first.

If after installing the three you decide your friction was elsewhere — your call, override the recommendation. The file primitives are zero-cost to install (`rm` undoes them); the digest VM is a real build, so getting the order right matters more.

---

## Phase 1 — Three file primitives

These install on whichever host runs your `~/.claude/` directory — usually your laptop or workstation, not the VM itself unless your VM is also your Claude Code host. **No VM-specific steps in this phase.** Follow the steps in `INSTALL.md` (Steps 1-3). Summary:

1. Clone the muckers repo (`git clone https://github.com/NorthwoodsSentinel/muckers.git`)
2. Copy `templates/STANDING_RULES.template.md` to `~/.claude/PAI/USER/STANDING_RULES.md` and ensure `@PAI/USER/STANDING_RULES.md` is in your `~/.claude/CLAUDE.md` imports
3. Copy `templates/AGENDA.template.md` to your project dir under `~/.claude/projects/<your-project-slug>/AGENDA.md`
4. Copy `skills/DualMode/` into `~/.claude/skills/DualMode/`

Open a fresh Claude Code session in your project dir to verify: ask *"what rules are loaded for me?"* (verifies STANDING_RULES @-import). File a test agenda ticket; close the session; reopen; ticket should still be there (verifies cross-session persistence). DualMode auto-activates on parallel-tracked work — try *"enter Dual Mode"* in a real session to verify the skill loads.

---

## Phase 2 — digest (and later organizer) via workerd on your VM

This is the actual VM piece: running muckers' synthesis primitives independently of Cloudflare's paid plan, on a Linux VM you control.

### Architecture sketch

```
┌──────────────────────────────────────────────────────────────────┐
│ Linux VM (Debian 12 / Ubuntu 22.04 / similar)                    │
│                                                                  │
│   workerd (systemd unit, always-on)                              │
│   └─ executes muckers digest.js (CF Worker source, unchanged)    │
│                                                                  │
│   miniflare-style bindings (via workerd config):                 │
│   ├─ D1   → SQLite file on local disk                            │
│   ├─ KV   → JSON files                                           │
│   └─ R2   → directory tree                                       │
│                                                                  │
│   AI dispatch helper (~30 LOC):                                  │
│   ├─ Anthropic API (your key, pennies per digest)                │
│   └─ OR local Ollama (your GPU, full sovereignty)                │
│                                                                  │
│   cron (host-level) → curls workerd /digest endpoint             │
│                       on schedule (e.g. daily 06:00)             │
└──────────────────────────────────────────────────────────────────┘
```

### Model-backend choice

Two clean options; pick whichever matches the cost-vs-sovereignty profile you want:

**A. Cloud (Anthropic API).** A daily digest of roughly 50 source items into a ~500-word synthesis runs on Claude Haiku 4.5 at roughly $0.005–0.01 per digest. ~$0.30/month at daily cadence. Trivial cost. No GPU load. Requires an Anthropic API key in environment.

**B. Local (Ollama).** A 13B-class model (Llama 3.3 13B, Qwen 2.5 14B, Mistral Nemo) fits in ~12-16 GB VRAM with usable context. Synthesis quality is below Sonnet but acceptable for digest. Zero cloud spend; full sovereignty. Adds 3-15 seconds per digest depending on model and quantization.

The AI dispatch helper switches between the two via an env var:

```
DIGEST_MODEL_BACKEND=anthropic   # or "ollama"
```

Five lines of switch logic; no code change needed to swap.

### What's NOT yet shipping in this doc

Being explicit so deferred work is visible, not pretended-resolved:

- **The actual workerd-on-VM adapter code is not yet in this repo.** The architecture above is honest about that. Phase 2 install steps will land in this file or a sibling once the adapter is built. Track progress at the muckers repo's open issues.
- **organizer-on-VM** follows the same workerd-config + systemd-unit + AI-dispatch-helper pattern as digest. Ships after digest is proven.
- **GUI / dashboard.** muckers is CLI + cron primitives by design. If you want a dashboard view, that's a separate project — probably a small static page that reads the same SQLite file via a separate Worker. Not in scope here.

### Why workerd vs a custom adapter

Earlier iterations of this doc speced a custom Hono-on-Node adapter (~300 LOC) for running muckers' worker source on a VM. Then `workerd` (Cloudflare's open-source Workers runtime) was the cleaner answer: same runtime that runs production Cloudflare Workers, installable on any POSIX box, with native support for the bindings muckers uses. Combined with miniflare-style local backings (SQLite for D1, file-based for KV/R2), the VM port collapses from a custom adapter to a config file + a systemd unit + a small AI-dispatch helper. Roughly 50 LOC of new code, not 300.

---

## Where to take questions or report friction

- **GitHub issues:** `https://github.com/NorthwoodsSentinel/muckers/issues`
- **Pull requests welcome** for the Phase 2 adapter scaffold, model-dispatch helper improvements, or any of the deferred work above.

---

## Provenance

The five primitives (digest / organizer / STANDING_RULES / AGENDA / DualMode) are named after Thomas Edison's *muckers* — his core team at Menlo Park (Charles Batchelor, John Kruesi, Francis Upton). Each primitive maps to one of Edison's documented lab practices. The repo's `HISTORY.md` walks through that mapping.

License: Apache 2.0. Use freely; contribute back if it helps.
