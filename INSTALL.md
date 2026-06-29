# Install the muckers toolkit

> Walk this in order. Each section can be installed independently — you don't need all five.

## Prerequisites

- A Cloudflare account (free tier works for low-volume usage).
- For the digest + organizer Workers: an Anthropic API key (digest can fall back to Workers AI if you don't have one; organizer requires Anthropic).
- For the file primitives (STANDING_RULES, AGENDA, DualMode): your existing PAI layout or any agent platform that loads always-on context files.

---

## Step 1 — Install STANDING_RULES.md (5 minutes, no Worker)

The constitutional layer that sits above your memory tree. Always loads, never truncates.

```bash
# For Claude Code with PAI 5.0:
cp templates/STANDING_RULES.md ~/.claude/PAI/USER/STANDING_RULES.md
```

Add an `@`-import to your CLAUDE.md so the file always loads:
```markdown
@PAI/USER/STANDING_RULES.md
```

**Replace the EXAMPLE sections** with your actual rules. Write rules in response to observed failures, not preemptively. The template's example rules are shaped by the author's failure history; yours will differ.

Re-audit every 3-6 months. Rules that never fire should be removed.

---

## Step 2 — Install AGENDA.md (5 minutes, no Worker)

The cross-session ticket store.

```bash
cp templates/AGENDA.md ~/your-shuttle/AGENDA.md
# or
cp templates/AGENDA.md ~/.claude/PAI/AGENDA.md
```

Tell your main agent (via STANDING_RULES.md or a skill) the cadence:
- critical/high tickets: surface at session start or when explicitly asked
- medium/low/parked tickets: surface only on explicit ask

Number tickets sequentially as you add them. The four-field shape (compose / blocked / input-needed / default-if-agent-picks) is the load-bearing pattern.

---

## Step 3 — Install the Dual Mode skill (10 minutes, no Worker)

```bash
mkdir -p ~/.claude/PAI/skills/DualMode/Workflows
cp skills/dual-mode/Workflows/Protocol.md ~/.claude/PAI/skills/DualMode/Workflows/Protocol.md
```

Create a SKILL.md so your agent can invoke it:
```yaml
---
name: DualMode
description: Parallel-tracked-cognition protocol. When the operator is in deep dialogue elsewhere, ship reversible work + clean substrate + queue input-needed without pinging mid-mode. Exit surfaces consolidated input-list at top.
---
```

Add a trigger to your STANDING_RULES.md:
```markdown
When the operator says "dual mode" / "keep busy while I work with X" / "don't pull me out", invoke the DualMode skill and follow its protocol verbatim.
```

Depends on Step 2 — the deep-flow guarantee requires AGENDA.md to be the real ticket store.

---

## Step 4 — Deploy the digest Worker (15 minutes)

```bash
# Provision resources
wrangler d1 create muckers           # paste database_id into wrangler.toml
wrangler kv namespace create PREFS   # paste id into wrangler.toml
wrangler d1 migrations apply muckers --remote

# Set secrets
wrangler secret put PACK_TOKEN          # openssl rand -hex 32
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_DIGEST_PAT       # if using github source
wrangler secret put DISCORD_BOT_TOKEN       # if using discord_channel source
wrangler secret put DISCORD_DIGEST_WEBHOOK  # if using discord webhook delivery
wrangler secret put NTFY_DIGEST_TOPIC       # if using ntfy delivery

# Deploy
wrangler deploy
```

Test manually before wiring cron:
```bash
WORKER_URL="https://muckers.YOURSUBDOMAIN.workers.dev"
PACK_TOKEN="..."
curl -X POST "$WORKER_URL/digest/run" \
  -H "X-Pack-Token: $PACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sources": [
      {"type": "github", "config": {"repos": ["yourname/your-repo"], "since_hours": 24}},
      {"type": "manual_note", "config": {"text": "I shipped X today and I am stuck on Y."}}
    ],
    "delivery_targets": [
      {"type": "substrate", "tag": "digest-morning"}
    ]
  }'
```

Once you have a shape that works, store it as the cron config:
```bash
# Get the request body you used above, store it under KV key digest:cron_config
wrangler kv key put "digest:cron_config" '{"sources":[...],"delivery_targets":[...]}' --binding=PREFS
```

The cron is set to fire daily at 12:00 UTC by default — edit `wrangler.toml` `[triggers]` `crons` to change. Deploy after editing.

Verify the cron fired:
```bash
curl "$WORKER_URL/digest/list" -H "X-Pack-Token: $PACK_TOKEN"
```

Your main agent reads `GET /digest/latest` at session start to pull the morning brief.

---

## Step 5 — Enable the organizer (5 minutes)

The organizer is purely additive — no extra configuration beyond the secrets you set in Step 4 (it uses `ANTHROPIC_API_KEY`).

Run a scan:
```bash
curl -X POST "$WORKER_URL/organizer/scan" \
  -H "X-Pack-Token: $PACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"since_hours": 168}'
```

See proposals that have crossed the rule-of-three threshold:
```bash
curl "$WORKER_URL/organizer/proposals?status=open&min_hits=3" \
  -H "X-Pack-Token: $PACK_TOKEN"
```

Mark a proposal acknowledged:
```bash
curl -X POST "$WORKER_URL/organizer/proposals/$PROPOSAL_ID/acknowledge" \
  -H "X-Pack-Token: $PACK_TOKEN"
```

Mark formalized (you built the tool):
```bash
curl -X POST "$WORKER_URL/organizer/proposals/$PROPOSAL_ID/formalize" \
  -H "X-Pack-Token: $PACK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"formalized_as": "the-tool-or-skill-you-built"}'
```

Or dismiss:
```bash
curl -X POST "$WORKER_URL/organizer/proposals/$PROPOSAL_ID/dismiss" \
  -H "X-Pack-Token: $PACK_TOKEN"
```

You can set a second cron to fire scans automatically. Default is operator-initiated — scans are intentional acts, not background noise.

---

## What to do next

Once all five primitives are installed and running for a week or two:
- A clean constitutional rule layer (STANDING_RULES) that prevents corrections from drifting
- A ticket store (AGENDA) that holds everything that doesn't belong in mid-flow conversation
- A protocol (DualMode) that lets you parallel-track without your main agent pinging you
- A daily digest that catches your main agent up at session start without you re-explaining yesterday
- An organizer that watches the digest archive and tells you when you've built the same shape 3+ times

If any of the primitives improves on your stack — a sharper STANDING_RULES rule, a better digest source-reader, a hardening to the organizer's shape-detection prompt — PR back to `github.com/NorthwoodsSentinel/muckers`.

See [HISTORY.md](HISTORY.md) for the Edison-team origin story.
