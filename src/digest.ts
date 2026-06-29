/**
 * digest.ts — the muckers' daily journal
 *
 * Cron-fired (or manually triggered via POST /digest/run). Reads configured
 * source-readers, calls Anthropic (or Workers AI fallback) to synthesize a
 * morning brief in operator-voice, delivers to configured targets (Discord
 * webhook, ntfy, substrate D1, file marker).
 *
 * Edison analog: in 1880, while the lab was subdividing electrical-system
 * work across teams, Edison had office staff keep a daily journal of what
 * was happening across the laboratory. The digest endpoint is the modern
 * shape of that practice — the agent reads source-readers (git activity,
 * channel traffic, manual notes) and produces the equivalent of the 1880
 * daily journal entry, automatically, for the operator's main agent to
 * read at the next session start.
 *
 * The journal entry replaces the "what did I work on yesterday + what's
 * queued for tomorrow" mental accounting that would otherwise sit in the
 * operator's head between sessions.
 */

import { json, Env } from "./common";

interface SourceConfig {
  type: "github" | "file_mtime" | "discord_channel" | "manual_note";
  // GitHub: { repos: ["owner/repo", ...], since_hours: 24 }
  // file_mtime: { dirs: ["/path"], since_hours: 24 }
  // discord_channel: { channel_id: "...", bot_token_secret: "BOT_TOKEN", since_hours: 24 }
  // manual_note: { text: "..." }
  config: Record<string, unknown>;
}

interface DigestRequest {
  triggered_by: "cron" | "manual";
  sources: SourceConfig[];
  delivery_targets: DeliveryTarget[];
  model_pref?: "anthropic" | "workers_ai";
  custom_prompt_addendum?: string;
}

type DeliveryTarget =
  | { type: "file"; path: string }
  | { type: "discord_webhook"; url?: string }
  | { type: "ntfy"; topic?: string }
  | { type: "substrate"; tag: string };

interface SourceReadResult {
  source_type: string;
  source_label: string;
  items: { ts?: string; title: string; body: string }[];
  error?: string;
}

const SYSTEM_PROMPT_DEFAULT = `You are the operator's digest synthesizer.

Your job: read the raw activity feeds below (git commits, file changes, agent transcripts, optional channel messages) and produce a single morning brief that the operator's main agent reads at session start.

Format the brief as plain prose with three sections, in this order:

## What landed since the last digest
A short paragraph (3-6 sentences) covering the most consequential things actually completed. Name specific artifacts (commit SHAs, file paths, PR numbers) when present. Do not narrate intent; report shipped state.

## What's open mid-flight
A second short paragraph (2-4 sentences) covering work that started but isn't done. Be honest about what's stuck or stalled vs what's actively progressing.

## Patterns worth surfacing
A third short paragraph (2-4 sentences) covering any cross-cutting observations: tools the operator built that look similar to other tools, problems that appeared in multiple contexts, decisions queued that have been pending for a while. If nothing notable, say so honestly — don't manufacture observations.

Voice rules:
- Prose default, NO bullet lists (the operator's ADHD architecture means bullet walls pull attention out of the line they're tracking).
- Concrete artifacts over generic statements ("commit a1b2c3d touched src/foo.ts" not "made progress on the codebase").
- No progress-theater language ("great progress", "crushing it", "going well"). The operator is calibrated; honest reports win.
- No closing summary that just restates the body. End on the substantive point.
- Aim for ~300-500 words total across all three sections.`;

function nowIso(): string {
  return new Date().toISOString();
}

async function readGitHub(
  cfg: Record<string, unknown>,
  env: Env,
): Promise<SourceReadResult> {
  const repos = Array.isArray(cfg.repos) ? (cfg.repos as string[]) : [];
  const sinceHours = typeof cfg.since_hours === "number" ? cfg.since_hours : 24;
  const sinceDate = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const items: { ts: string; title: string; body: string }[] = [];

  const token = (env as unknown as Record<string, string>).GITHUB_DIGEST_PAT;
  if (!token) {
    return {
      source_type: "github",
      source_label: repos.join(", "),
      items: [],
      error: "GITHUB_DIGEST_PAT secret not set — set via `wrangler secret put`",
    };
  }

  for (const repo of repos) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/commits?since=${sinceDate}&per_page=20`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "muckers/digest",
            Accept: "application/vnd.github+json",
          },
        },
      );
      if (!res.ok) {
        items.push({
          ts: nowIso(),
          title: `[error] ${repo} returned ${res.status}`,
          body: "",
        });
        continue;
      }
      const commits = (await res.json()) as {
        sha: string;
        commit: { message: string; author: { name: string; date: string } };
        html_url: string;
      }[];
      for (const c of commits) {
        items.push({
          ts: c.commit.author.date,
          title: `${repo} ${c.sha.slice(0, 7)} — ${c.commit.message.split("\n")[0]}`,
          body: `${c.commit.author.name} @ ${c.commit.author.date}\n${c.html_url}\n${c.commit.message.slice(0, 800)}`,
        });
      }
    } catch (err) {
      items.push({
        ts: nowIso(),
        title: `[error] ${repo}: ${String(err)}`,
        body: "",
      });
    }
  }

  return {
    source_type: "github",
    source_label: `github(${repos.join(", ")})`,
    items,
  };
}

async function readDiscordChannel(
  cfg: Record<string, unknown>,
  env: Env,
): Promise<SourceReadResult> {
  const channelId = String(cfg.channel_id ?? "");
  const sinceHours = typeof cfg.since_hours === "number" ? cfg.since_hours : 24;
  const tokenSecret = String(cfg.bot_token_secret ?? "DISCORD_BOT_TOKEN");
  const token = (env as unknown as Record<string, string>)[tokenSecret];

  if (!token || !channelId) {
    return {
      source_type: "discord_channel",
      source_label: channelId,
      items: [],
      error: `missing ${tokenSecret} secret or channel_id`,
    };
  }

  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?limit=50`,
      { headers: { Authorization: `Bot ${token}` } },
    );
    if (!res.ok) {
      return {
        source_type: "discord_channel",
        source_label: channelId,
        items: [],
        error: `Discord API ${res.status}`,
      };
    }
    const msgs = (await res.json()) as {
      id: string;
      content: string;
      timestamp: string;
      author: { username: string };
    }[];
    const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
    const items = msgs
      .filter((m) => new Date(m.timestamp).getTime() >= cutoff)
      .map((m) => ({
        ts: m.timestamp,
        title: `[#${channelId}] ${m.author.username}`,
        body: m.content.slice(0, 600),
      }));
    return {
      source_type: "discord_channel",
      source_label: `discord(${channelId})`,
      items,
    };
  } catch (err) {
    return {
      source_type: "discord_channel",
      source_label: channelId,
      items: [],
      error: String(err),
    };
  }
}

async function readManualNote(
  cfg: Record<string, unknown>,
): Promise<SourceReadResult> {
  const text = String(cfg.text ?? "");
  return {
    source_type: "manual_note",
    source_label: "manual",
    items: text ? [{ ts: nowIso(), title: "manual note", body: text }] : [],
  };
}

async function readSources(
  sources: SourceConfig[],
  env: Env,
): Promise<SourceReadResult[]> {
  const out: SourceReadResult[] = [];
  for (const s of sources) {
    try {
      if (s.type === "github") out.push(await readGitHub(s.config, env));
      else if (s.type === "discord_channel")
        out.push(await readDiscordChannel(s.config, env));
      else if (s.type === "manual_note") out.push(await readManualNote(s.config));
      else
        out.push({
          source_type: s.type,
          source_label: s.type,
          items: [],
          error: `source type '${s.type}' not yet implemented`,
        });
    } catch (err) {
      out.push({
        source_type: s.type,
        source_label: s.type,
        items: [],
        error: String(err),
      });
    }
  }
  return out;
}

async function synthesizeWithAnthropic(
  raw: SourceReadResult[],
  apiKey: string,
  customAddendum: string | undefined,
): Promise<string> {
  const systemPrompt = customAddendum
    ? `${SYSTEM_PROMPT_DEFAULT}\n\n## Custom addendum\n${customAddendum}`
    : SYSTEM_PROMPT_DEFAULT;

  const rawPacked = raw
    .map(
      (r) =>
        `### Source: ${r.source_label} (${r.source_type})\n` +
        (r.error ? `(error: ${r.error})\n` : "") +
        r.items
          .slice(0, 30)
          .map((i) => `- [${i.ts ?? "?"}] ${i.title}\n  ${i.body}`)
          .join("\n") +
        (r.items.length > 30 ? `\n(... ${r.items.length - 30} more items truncated)` : ""),
    )
    .join("\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: "user", content: rawPacked || "(no source items)" }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
}

async function synthesizeWithWorkersAi(
  raw: SourceReadResult[],
  env: Env,
  customAddendum: string | undefined,
): Promise<string> {
  const systemPrompt = customAddendum
    ? `${SYSTEM_PROMPT_DEFAULT}\n\n## Custom addendum\n${customAddendum}`
    : SYSTEM_PROMPT_DEFAULT;
  const rawPacked = raw
    .map(
      (r) =>
        `Source ${r.source_label}: ${r.items
          .slice(0, 30)
          .map((i) => `${i.title} :: ${i.body}`)
          .join(" | ")}`,
    )
    .join("\n");

  const result = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct" as never, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: rawPacked || "(no source items)" },
    ],
    max_tokens: 1200,
  } as never)) as { response?: string };
  return (result.response ?? "").trim();
}

async function deliverDigest(
  text: string,
  targets: DeliveryTarget[],
  env: Env,
): Promise<{ target: string; ok: boolean; err?: string }[]> {
  const results: { target: string; ok: boolean; err?: string }[] = [];

  for (const t of targets) {
    try {
      if (t.type === "discord_webhook") {
        const url = t.url ?? env.DISCORD_DIGEST_WEBHOOK;
        if (!url) {
          results.push({ target: "discord_webhook", ok: false, err: "no webhook url" });
          continue;
        }
        const chunks = chunkForDiscord(text, 1900);
        for (const c of chunks) {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: c }),
          });
          if (!res.ok) throw new Error(`Discord webhook ${res.status}`);
        }
        results.push({ target: "discord_webhook", ok: true });
      } else if (t.type === "ntfy") {
        const topic = t.topic ?? env.NTFY_DIGEST_TOPIC;
        if (!topic) {
          results.push({ target: "ntfy", ok: false, err: "no ntfy topic" });
          continue;
        }
        await fetch(`https://ntfy.sh/${topic}`, {
          method: "POST",
          headers: { Title: "Morning digest", Tags: "digest,morning" },
          body: text.slice(0, 4000),
        });
        results.push({ target: "ntfy", ok: true });
      } else if (t.type === "substrate") {
        await env.DB.prepare(
          `INSERT INTO substrate_entries (id, body, tag, type, created_at) VALUES (?, ?, ?, 'digest', ?)`,
        )
          .bind(crypto.randomUUID(), text, t.tag, nowIso())
          .run();
        results.push({ target: "substrate", ok: true });
      } else if (t.type === "file") {
        // File delivery is for cohort-tier setups that mount KV or R2 outside the Worker.
        // Here we surface the intent and store the path; the operator's external job
        // reads the digest from the /digest/latest endpoint and writes to the file.
        results.push({
          target: `file(${t.path})`,
          ok: true,
          err: "stored for /digest/latest pull",
        });
      }
    } catch (err) {
      results.push({ target: t.type, ok: false, err: String(err) });
    }
  }
  return results;
}

function chunkForDiscord(text: string, max: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + max));
    i += max;
  }
  return chunks;
}

async function runDigest(
  req: DigestRequest,
  env: Env,
): Promise<{
  run_id: string;
  digest: string;
  delivery: { target: string; ok: boolean; err?: string }[];
}> {
  const run_id = crypto.randomUUID();
  const started_at = nowIso();

  await env.DB.prepare(
    `INSERT INTO digest_runs (id, triggered_by, started_at, status, sources_json) VALUES (?, ?, ?, 'started', ?)`,
  )
    .bind(run_id, req.triggered_by, started_at, JSON.stringify(req.sources))
    .run();

  let digestText = "";
  let deliveryResults: { target: string; ok: boolean; err?: string }[] = [];
  try {
    const raw = await readSources(req.sources, env);
    const useAnthropic = req.model_pref !== "workers_ai" && env.ANTHROPIC_API_KEY;
    digestText = useAnthropic
      ? await synthesizeWithAnthropic(raw, env.ANTHROPIC_API_KEY!, req.custom_prompt_addendum)
      : await synthesizeWithWorkersAi(raw, env, req.custom_prompt_addendum);
    deliveryResults = await deliverDigest(digestText, req.delivery_targets, env);

    await env.DB.prepare(
      `UPDATE digest_runs SET completed_at = ?, status = 'done', digest_text = ?, delivery_targets_json = ?, delivery_results_json = ? WHERE id = ?`,
    )
      .bind(
        nowIso(),
        digestText,
        JSON.stringify(req.delivery_targets),
        JSON.stringify(deliveryResults),
        run_id,
      )
      .run();
  } catch (err) {
    await env.DB.prepare(
      `UPDATE digest_runs SET completed_at = ?, status = 'failed', failure_reason = ? WHERE id = ?`,
    )
      .bind(nowIso(), String(err), run_id)
      .run();
    throw err;
  }

  return { run_id, digest: digestText, delivery: deliveryResults };
}

// ── HTTP handlers ─────────────────────────────────────────────────────────

export async function handleDigestRun(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Partial<DigestRequest>;
  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    return json(
      { error: "sources[] required; see /digest/schema for shape" },
      400,
    );
  }
  if (!Array.isArray(body.delivery_targets) || body.delivery_targets.length === 0) {
    return json(
      { error: "delivery_targets[] required; see /digest/schema for shape" },
      400,
    );
  }
  try {
    const result = await runDigest(
      {
        triggered_by: "manual",
        sources: body.sources,
        delivery_targets: body.delivery_targets,
        model_pref: body.model_pref,
        custom_prompt_addendum: body.custom_prompt_addendum,
      },
      env,
    );
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

export async function handleDigestLatest(_req: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, started_at, completed_at, status, digest_text, delivery_results_json
     FROM digest_runs WHERE status = 'done' ORDER BY started_at DESC LIMIT 1`,
  ).first();
  if (!row) return json({ ok: false, error: "no completed digest runs yet" }, 404);
  return json({ ok: true, run: row });
}

export async function handleDigestList(_req: Request, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, triggered_by, started_at, completed_at, status, failure_reason
     FROM digest_runs ORDER BY started_at DESC LIMIT 20`,
  ).all();
  return json({ ok: true, runs: result.results });
}

export async function handleDigestSchema(_req: Request): Promise<Response> {
  return json({
    ok: true,
    endpoints: {
      "POST /digest/run": {
        body: {
          sources: "SourceConfig[]",
          delivery_targets: "DeliveryTarget[]",
          model_pref: "anthropic | workers_ai (optional, default anthropic if key set)",
          custom_prompt_addendum: "string (optional, additional voice instructions)",
        },
      },
      "GET /digest/latest": { returns: "the most recent completed digest" },
      "GET /digest/list": { returns: "last 20 digest runs (metadata only)" },
    },
    source_types: {
      github: { config: { repos: ["owner/repo"], since_hours: 24 }, secret: "GITHUB_DIGEST_PAT" },
      discord_channel: {
        config: { channel_id: "...", bot_token_secret: "DISCORD_BOT_TOKEN", since_hours: 24 },
        secret: "(the secret name in config.bot_token_secret)",
      },
      manual_note: { config: { text: "..." } },
      file_mtime: { status: "not_yet_implemented", note: "Workers can't read host filesystem" },
    },
    delivery_targets: {
      discord_webhook: { config: { url: "https://discord.com/api/webhooks/..." }, fallback_secret: "DISCORD_DIGEST_WEBHOOK" },
      ntfy: { config: { topic: "your-topic" }, fallback_secret: "NTFY_DIGEST_TOPIC" },
      substrate: { config: { tag: "digest-morning" }, note: "stores in northwoods-pack substrate D1" },
      file: { config: { path: "/path/intent-marker" }, note: "stored as marker; pull via /digest/latest from external job" },
    },
  });
}

// Cron handler — runs from src/index.ts scheduled() if cron is configured.
export async function runScheduledDigest(env: Env): Promise<void> {
  // Default cron config: read from KV (key "digest:cron_config") if present;
  // otherwise log no-op. Operator configures via POST /digest/cron-config.
  const configRaw = await env.PREFS.get("digest:cron_config");
  if (!configRaw) return;
  let cfg: DigestRequest;
  try {
    cfg = JSON.parse(configRaw);
  } catch {
    return;
  }
  await runDigest({ ...cfg, triggered_by: "cron" }, env).catch(() => {
    /* failure already recorded in D1 */
  });
}
