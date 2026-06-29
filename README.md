# muckers

> Five primitives for operators who run a many-agent fleet and need the operational discipline that fourteen lab assistants gave Edison. Named after his team.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NorthwoodsSentinel/muckers)

> Part of the [Northwoods stack](https://github.com/NorthwoodsSentinel) — substrate-first personal AI infrastructure on Cloudflare. Composes with [`northwoods-pack`](https://github.com/NorthwoodsSentinel/northwoods-pack) if you have one. Works standalone if you don't.

---

## Why this exists

In 1880, while the Menlo Park lab was subdividing electrical-system work across teams of researchers, **Thomas Edison had one of his office staff keep a daily journal of work going on at the laboratory.** Not Edison himself — a clerk. Whose entire job for that period was to walk the lab, note what each team was doing, and write it down where Edison and the senior muckers could re-orient the next morning.

That journal is preserved in the Edison Papers archive. The toolkit's `digest` endpoint is its modern shape. The other four primitives — `organizer`, `STANDING_RULES.md`, `AGENDA.md`, `DualMode` — each map to a specific practice from the Menlo Park lab.

**Read [HISTORY.md](HISTORY.md) for the full mapping** — who the muckers were, what was in the notebooks, why each primitive earned its place.

---

## What's in here

| Primitive | Shape | What it does |
|---|---|---|
| **digest** | CF Worker + cron + D1 | Daily morning brief synthesizing yesterday's activity across configurable sources (git, channel msgs, manual notes). Anthropic synthesis with Workers AI fallback. Delivers to Discord webhook / ntfy / substrate / file marker. Your main agent reads `GET /digest/latest` at session start. |
| **organizer** | CF Worker reading the digest archive | Rule-of-three tool-shape detector. When the same shape appears in 3+ digests, surfaces a proposal for the operator to acknowledge / formalize / dismiss. Encoded as the rule the muckers practiced: a problem solved three times earns a named place in the standing kit. |
| **STANDING_RULES.md** | File convention | Constitutional layer above your memory tree. Under 100 lines, always loaded, never truncates. Holds the rules-that-govern-every-turn so corrections land once and persist. |
| **AGENDA.md** | Markdown ticket store | Cross-session ticket store with cadence rules. Below-high-tier tickets stay there and don't surface mid-flow. The deep-flow guarantee that lets one-session-as-manager actually work without losing threads. |
| **DualMode** | Skill workflow | Named operational mode for parallel-tracked work. Your main agent ships reversible work + cleans substrate + queues input-needed with zero mid-mode pings. Edison-analog: the standing instructions the muckers had for when Edison was away. |

## Who this is for

Operators who have:
- Scaled to many agents (each needed to keep context fresh on a specific domain), and
- Hit the orchestration tax — managing N agents was costing more attention than running 1, and
- Are now consolidating toward "one main agent as manager" but losing thread-continuity in the process.

Operators it's NOT for:
- People who thrive on cockpit-style multi-agent conducting (this is for operators who run out of attention before agents do, not for operators with infinite parallel-conducting capacity)
- People who want a single-agent overnight-polish workflow with no fleet underneath (use a simpler skill, not this toolkit)

## Install

### Option A — 1-click (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NorthwoodsSentinel/muckers)

Then set your secrets (see "Set secrets" below) and apply the migration.

### Option B — local clone

```bash
git clone https://github.com/NorthwoodsSentinel/muckers.git
cd muckers
bun install
wrangler d1 create muckers     # paste database_id into wrangler.toml
wrangler kv namespace create PREFS  # paste id into wrangler.toml
wrangler d1 migrations apply muckers --remote
wrangler deploy
```

### Set secrets (both options)

```bash
wrangler secret put PACK_TOKEN          # generate: openssl rand -hex 32
wrangler secret put ANTHROPIC_API_KEY   # required for organizer; recommended for digest
wrangler secret put GITHUB_DIGEST_PAT   # required if any digest source.type = "github"
wrangler secret put DISCORD_BOT_TOKEN   # required if any source.type = "discord_channel"
wrangler secret put DISCORD_DIGEST_WEBHOOK  # optional delivery fallback
wrangler secret put NTFY_DIGEST_TOPIC       # optional delivery fallback
```

### Install the file primitives

The STANDING_RULES.md / AGENDA.md / DualMode pieces don't need a Worker — they're file conventions you copy into your existing PAI layout. See [skills/dual-mode/Workflows/Protocol.md](skills/dual-mode/Workflows/Protocol.md) and [templates/](templates/).

Full step-by-step in [INSTALL.md](INSTALL.md).

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | service info + module status (no auth) |
| `/digest/run` | POST | manually trigger a digest (auth) |
| `/digest/latest` | GET | most recent completed digest (auth) |
| `/digest/list` | GET | last 20 digest run metadata (auth) |
| `/digest/schema` | GET | digest endpoint shapes (no auth) |
| `/organizer/scan` | POST | scan digest archive for repeated shapes (auth) |
| `/organizer/proposals` | GET | list rule-of-three proposals (auth) |
| `/organizer/proposals/:id/acknowledge` | POST | mark proposal as seen (auth) |
| `/organizer/proposals/:id/formalize` | POST | mark proposal as resolved by building tool (auth) |
| `/organizer/proposals/:id/dismiss` | POST | mark proposal as not-worth-pursuing (auth) |
| `/organizer/schema` | GET | organizer endpoint shapes (no auth) |

Auth: `X-Pack-Token: $YOUR_PACK_TOKEN` header on every authed request.

## PR-back loop

Apache 2.0. If you improve any of the five primitives running on your own stack, PR back to `github.com/NorthwoodsSentinel/muckers`. The toolkit is shaped by lived friction from one operator; your friction-fixes make it better for the next one.

## Composes with

- [`northwoods-pack`](https://github.com/NorthwoodsSentinel/northwoods-pack) — the substrate D1 binding is interoperable; digests can be delivered into the pack's substrate module for cross-tool retrieval
- [`bivouac`](https://github.com/NorthwoodsSentinel/bivouac) — the autonomous overnight coding agent; bivouac's per-run receipts are a natural digest source
- [`mycelia`](https://github.com/wally-kroeker/mycelia) — agent mutual aid protocol; digests can be a Mycelia-distributable artifact

## Provenance

Built by Rob Chuvala (Northwoods Sentinel Labs). Every primitive earned its existence by addressing a problem that occurred three or more times on the author's own stack — the same rule-of-three philosophy the organizer enforces. Nothing in here is theoretical.

The Edison framing is real history. See [HISTORY.md](HISTORY.md) for sources.

## License

[Apache 2.0](LICENSE)
