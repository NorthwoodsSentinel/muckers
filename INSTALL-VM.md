# INSTALL-VM.md — muckers on a Linux VM (Proxmox, vanilla, anything POSIX)

For users running muckers outside Cloudflare's hosted runtime — own VM, own Proxmox host, own dedicated box. Companion to `INSTALL.md` (the cleanest path, on top of Cloudflare Workers + Claude Code + PAI).

This doc is sequenced for the **cloud-bridge learning path** — you want to understand how the Cloudflare-shape stack actually runs, and you want to run it on your own iron. Phase 1 stands up the synthesis primitives (`digest` + `organizer`) on `workerd` + MinIO + SQLite on your VM. Phase 2 layers the state-management file primitives on top.

---

## TL;DR

If your goal is cloud-bridge knowledge — you're learning the Cloudflare Workers runtime, you want to understand how D1/KV/R2 bindings actually work, you'd rather run it on iron you control — start with **Phase 1**. The `digest` and `organizer` Workers run on Cloudflare's open-source `workerd` runtime. MinIO replaces R2 for object storage. SQLite replaces D1. A small AI-dispatch helper switches between Anthropic API and a local Ollama model based on whether you want cloud spend or local sovereignty.

If your goal is faster everyday productivity wins on an existing Claude Code + PAI install, **Phase 2** (state-management file primitives — STANDING_RULES + AGENDA + DualMode) drops in cleanly without any VM work. Most users hit those first. You can install Phase 2 whenever; it's not gated by Phase 1.

---

## Phase 1 — workerd + MinIO + digest worker on your VM

### What you're standing up

The architecture under the muckers `digest` and `organizer` workers is the standard Cloudflare Workers shape: a Worker script that uses bindings to D1 (SQLite), KV (key-value store), R2 (S3-compatible object storage), and optionally calls the Workers AI gateway. To run that locally, four pieces compose:

`workerd` is Cloudflare's open-source Workers runtime — the same C++ binary that runs production Workers, packaged as a long-running POSIX service. It reads a config file declaring your Worker script + bindings.

`miniflare`-style local bindings provide the D1 / KV / R2 surfaces. For development and small production you can use SQLite for D1, a file-backed directory for KV, and a local filesystem path for R2.

For real R2 substitution at scale on your VM, `MinIO` is the production-grade S3-compatible alternative — runs in a container, exposes the same API surface R2 exposes, no code changes to the Worker.

The AI-dispatch helper is a small TypeScript file (~30 LOC) that the Worker calls instead of the Workers AI binding. It reads an env var and routes the call to either the Anthropic API or a local Ollama endpoint. Switching is one env var change, no code redeploy.

### Architecture sketch

```
┌──────────────────────────────────────────────────────────────────┐
│ Proxmox VE host                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Linux VM (Debian 12 or Ubuntu 22.04)                       │  │
│  │                                                            │  │
│  │   workerd (systemd unit, always-on)                        │  │
│  │   └─ runs muckers digest.ts + organizer.ts unchanged       │  │
│  │                                                            │  │
│  │   Bindings (via workerd config):                           │  │
│  │   ├─ D1   → SQLite file at /var/lib/muckers/db.sqlite      │  │
│  │   ├─ KV   → directory at /var/lib/muckers/kv/              │  │
│  │   └─ R2   → MinIO at http://localhost:9000 (S3 API)        │  │
│  │                                                            │  │
│  │   AI dispatch helper (~30 LOC):                            │  │
│  │   ├─ DIGEST_MODEL_BACKEND=anthropic → Claude Haiku via API │  │
│  │   └─ DIGEST_MODEL_BACKEND=ollama    → local Ollama (16GB+) │  │
│  │                                                            │  │
│  │   MinIO (docker container):                                │  │
│  │   └─ S3-compatible object store, bucket = muckers-archive  │  │
│  │                                                            │  │
│  │   cron (host) → daily curl to workerd /digest endpoint     │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Install steps

The steps assume Debian 12 or Ubuntu 22.04 on the VM with root or sudo access.

**1. Install workerd.** Follow the [workerd README](https://github.com/cloudflare/workerd) — the binary is available via npm (`npm install -g workerd`) or as a prebuilt release download. Verify with `workerd --version`.

**2. Stand up MinIO via Docker.** The container is the cleanest production-grade local S3 surface:

```bash
docker run -d --name minio \
  -p 9000:9000 -p 9001:9001 \
  -v /var/lib/minio:/data \
  -e "MINIO_ROOT_USER=muckers-admin" \
  -e "MINIO_ROOT_PASSWORD=<choose-strong>" \
  minio/minio server /data --console-address ":9001"
```

Visit `http://localhost:9001` to access the console. Create a bucket named `muckers-archive`. Generate an access key + secret under Identity → Service Accounts; you'll wire those into the workerd config.

**3. Set up the local filesystem.**

```bash
sudo mkdir -p /var/lib/muckers/{kv,db,logs}
sudo chown -R $(whoami) /var/lib/muckers
```

**4. Clone muckers.**

```bash
git clone https://github.com/NorthwoodsSentinel/muckers.git
cd muckers
```

**5. Initialize SQLite for D1.** The migrations are in `migrations/` if they exist; otherwise the Worker auto-creates the schema on first run.

```bash
sqlite3 /var/lib/muckers/db/muckers.sqlite < migrations/0001_init.sql  # if present
```

**6. Create the workerd config.** Save as `/etc/muckers/workerd-config.capnp` (the workerd config language is Cap'n Proto — the workerd README has worked examples). The config declares the Worker script (`src/digest.ts`), the bindings (D1 → SQLite path, KV → directory, R2 → MinIO endpoint + credentials), and the listening port.

**7. Install the AI-dispatch helper.** The current muckers `src/digest.ts` calls Workers AI; for VM-on-workerd you swap that call for the dispatch helper. Sketch:

```typescript
// src/ai-dispatch.ts
export async function dispatch(prompt: string): Promise<string> {
  const backend = process.env.DIGEST_MODEL_BACKEND ?? 'anthropic';
  if (backend === 'ollama') {
    return ollamaCall(prompt);  // POST http://localhost:11434/api/generate
  }
  return anthropicCall(prompt);  // POST https://api.anthropic.com/v1/messages
}
```

**Model-backend tradeoff:**

The Anthropic path runs Claude Haiku at roughly $0.005–0.01 per digest synthesis of ~50 input items into ~500 output words. At daily cadence that's ~$0.30/month. No GPU load on your VM. Requires `ANTHROPIC_API_KEY` in env.

The Ollama path fits a 13B-class model (Llama 3.3 13B, Qwen 2.5 14B, Mistral Nemo) in roughly 12–16 GB VRAM with usable context. Quality is meaningfully below Sonnet/Haiku but acceptable for digest synthesis. Zero cloud spend, full sovereignty. Adds 3–15 seconds per digest depending on model and quantization. Install Ollama via `curl -fsSL https://ollama.com/install.sh | sh`, pull the model with `ollama pull llama3.3:13b`, set `DIGEST_MODEL_BACKEND=ollama`.

Switching is one env var change. You can prototype on Anthropic to validate the loop, then swap to Ollama once you've proved the digest output is useful.

**8. Create the systemd unit.** Save as `/etc/systemd/system/muckers-workerd.service`:

```ini
[Unit]
Description=muckers workerd
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/muckers/env
ExecStart=/usr/local/bin/workerd serve /etc/muckers/workerd-config.capnp
Restart=on-failure
User=muckers

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
sudo systemctl enable --now muckers-workerd
sudo systemctl status muckers-workerd
```

**9. Wire the cron.** Daily digest at 6 AM local:

```bash
0 6 * * * curl -s http://localhost:8080/digest >> /var/lib/muckers/logs/digest.log 2>&1
```

### Verify

```bash
# workerd is up
curl http://localhost:8080/health

# digest endpoint produces a synthesis (use a test signal set)
curl -X POST http://localhost:8080/digest -d '{"signals": [...]}'

# MinIO got the archived digest
mc ls minio/muckers-archive   # requires mc CLI configured
```

### What's NOT yet shipped

The workerd-on-VM adapter code — the specific config file + AI-dispatch helper port — isn't in the muckers repo yet at first publication. The architecture above is honest about that. Track progress at [github.com/NorthwoodsSentinel/muckers/issues](https://github.com/NorthwoodsSentinel/muckers/issues). When the adapter lands, it'll be a sibling directory `vm/` with the workerd config template + dispatch helper, drop-in installable on top of these instructions.

The `organizer` Worker follows the same pattern as `digest` (workerd config + dispatch helper + cron). Once `digest` is proven on your stack, `organizer` is small additional config.

A web GUI / dashboard is out of scope here. muckers is CLI + cron primitives by design. If you want a dashboard, build a separate small static page that reads the same SQLite file via a sibling Worker.

---

## Phase 2 — File primitives (state-management layer)

Three pure files that install on top of an existing Claude Code + PAI setup. No VM, no adapter, ~15 minutes. They live on whichever machine runs your `~/.claude/` directory — usually your workstation or laptop, not the VM itself unless the VM is your Claude Code host.

### What they do

**STANDING_RULES.md** is the agent's constitutional layer. Corrections you give the agent land once and persist across all sessions — the agent treats them as governing rules, not turn-by-turn context. You stop re-teaching the same lessons in every new chat.

**AGENDA.md** is the cross-session ticket store. Each ticket carries: ID, priority (critical / high / medium / low / parked), title, what's blocked, what input is needed, default if specified. Tickets survive sessions; the agent surfaces critical and high items at session start.

**DualMode skill** is the parallel-tracked work mode. When you're in deep dialogue with a different agent, you tell yours "enter Dual Mode" — it ships every queued reversible artifact, sweeps stale substrate, identifies decisions that need you, exits with only the input-needed items. Lets you keep flow on the primary thread without losing the secondary.

### Install

```bash
cd ~
git clone https://github.com/NorthwoodsSentinel/muckers.git  # if not already
cd muckers

# 1. STANDING_RULES
mkdir -p ~/.claude/PAI/USER
cp templates/STANDING_RULES.template.md ~/.claude/PAI/USER/STANDING_RULES.md
grep -q '@PAI/USER/STANDING_RULES.md' ~/.claude/CLAUDE.md || echo '@PAI/USER/STANDING_RULES.md' >> ~/.claude/CLAUDE.md

# 2. AGENDA
# Drop into your active project dir under ~/.claude/projects/
ls ~/.claude/projects/   # find your project slug
cp templates/AGENDA.template.md ~/.claude/projects/<your-project-slug>/AGENDA.md

# 3. DualMode skill
mkdir -p ~/.claude/skills/DualMode/Workflows
cp skills/DualMode/SKILL.md ~/.claude/skills/DualMode/SKILL.md
cp skills/DualMode/Workflows/*.md ~/.claude/skills/DualMode/Workflows/
```

Open a fresh Claude Code session in your project dir to verify: ask *"what rules are loaded for me?"* (verifies STANDING_RULES @-import). File a test agenda ticket; close the session; reopen; ticket should still be there (verifies cross-session persistence). DualMode auto-activates on parallel-tracked work — try *"enter Dual Mode"* in a real session to verify the skill loads.

---

## Where to take questions

GitHub issues: [github.com/NorthwoodsSentinel/muckers/issues](https://github.com/NorthwoodsSentinel/muckers/issues) — for bugs, install friction, missing docs, feature requests.

Pull requests welcome — particularly for the Phase 1 workerd adapter scaffold + AI-dispatch helper if you build it before the canonical version lands.

## Provenance

The five primitives (digest / organizer / STANDING_RULES / AGENDA / DualMode) are named after Thomas Edison's *muckers* — his core team at Menlo Park (Charles Batchelor, John Kruesi, Francis Upton). Each primitive maps to a documented practice from Edison's 1880 daily journal. See `HISTORY.md` for the mapping.

License: Apache 2.0.
