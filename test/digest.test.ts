/**
 * digest.test.ts — the digest module (src/digest.ts): source readers, synthesis, delivery, run bookkeeping,
 * the HTTP handlers and the cron entry point.
 *
 * Why: the digest reads third-party APIs and writes to D1 and to delivery targets; every path is driven here
 * through stubbed fetch and a fake D1 so the tests run with no account, no secret and no network.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  handleDigestLatest,
  handleDigestList,
  handleDigestRun,
  handleDigestSchema,
  runScheduledDigest,
} from "../src/digest";
import type { Env } from "../src/common";
import { anthropicText, fakeEnv, jsonResponse, post, stubFetch, type FetchCall, type SqlCall } from "./helpers/fakes";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";

afterEach(() => {
  vi.useRealTimers();
});

interface RunBody {
  ok: boolean;
  run_id?: string;
  digest?: string;
  delivery?: { target: string; ok: boolean; err?: string }[];
  error?: string;
}

async function run(env: Env, body: unknown): Promise<{ status: number; body: RunBody }> {
  const res = await handleDigestRun(post("/digest/run", body), env);
  return { status: res.status, body: (await res.json()) as RunBody };
}

function anthropicPrompt(calls: FetchCall[]): { system: string; content: string; model: string } {
  const c = calls.find((x) => x.url === ANTHROPIC);
  const parsed = JSON.parse(String(c?.init?.body)) as {
    system: string;
    model: string;
    messages: { content: string }[];
  };
  return { system: parsed.system, content: parsed.messages[0]!.content, model: parsed.model };
}

const finalUpdate = (calls: SqlCall[]) => calls.find((c) => c.sql.startsWith("UPDATE digest_runs"));

describe("POST /digest/run validation", () => {
  test("unparseable body -> 400 sources required", async () => {
    const { env } = fakeEnv();
    const r = await run(env, "not json");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("sources[] required");
  });

  test("empty sources -> 400", async () => {
    const { env } = fakeEnv();
    expect((await run(env, { sources: [], delivery_targets: [{ type: "file", path: "/x" }] })).status).toBe(400);
  });

  test("missing delivery_targets -> 400", async () => {
    const { env } = fakeEnv();
    const r = await run(env, { sources: [{ type: "manual_note", config: { text: "t" } }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("delivery_targets[] required");
  });

  test("empty delivery_targets -> 400", async () => {
    const { env } = fakeEnv();
    const r = await run(env, { sources: [{ type: "manual_note", config: {} }], delivery_targets: [] });
    expect(r.status).toBe(400);
  });
});

describe("a manual run through Anthropic", () => {
  test("reads every source kind, synthesizes, delivers and records the run as done", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    const { env, calls: sql } = fakeEnv({
      ANTHROPIC_API_KEY: "k-anthropic",
      GITHUB_DIGEST_PAT: "k-github",
      DISCORD_BOT_TOKEN: "k-discord",
    });
    const fetches = stubFetch((url) => {
      if (url.startsWith("https://api.github.com/repos/o/ok/")) {
        return jsonResponse([
          {
            sha: "abcdef1234567",
            html_url: "https://github.com/o/ok/commit/abcdef1",
            commit: { message: "first line\nsecond line", author: { name: "A", date: "2026-11-16T10:00:00Z" } },
          },
        ]);
      }
      if (url.startsWith("https://api.github.com/repos/o/bad/")) return new Response("no", { status: 404 });
      if (url.startsWith("https://api.github.com/repos/o/boom/")) throw new Error("net down");
      if (url.startsWith("https://discord.com/api/v10/channels/42/")) {
        return jsonResponse([
          { id: "1", content: "recent", timestamp: "2026-11-16T11:00:00Z", author: { username: "u" } },
          { id: "2", content: "old", timestamp: "2026-11-14T11:00:00Z", author: { username: "u" } },
        ]);
      }
      if (url === ANTHROPIC) return anthropicText("  the digest  ");
      return new Response("ok");
    });

    const r = await run(env, {
      sources: [
        { type: "github", config: { repos: ["o/ok", "o/bad", "o/boom"], since_hours: 48 } },
        { type: "discord_channel", config: { channel_id: "42" } },
        { type: "manual_note", config: { text: "a note" } },
        { type: "manual_note", config: {} },
        { type: "file_mtime", config: {} },
        { type: "github", config: null },
      ],
      delivery_targets: [
        { type: "file", path: "/tmp/marker" },
        { type: "substrate", tag: "digest-morning" },
      ],
      custom_prompt_addendum: "be terse",
    });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.digest).toBe("the digest");
    expect(r.body.delivery).toEqual([
      { target: "file(/tmp/marker)", ok: true, err: "stored for /digest/latest pull" },
      { target: "substrate", ok: true },
    ]);

    const gh = fetches.find((f) => f.url.includes("/o/ok/"));
    expect(gh?.url).toBe("https://api.github.com/repos/o/ok/commits?since=2026-11-14T12:00:00.000Z&per_page=20");
    expect((gh?.init?.headers as Record<string, string>).Authorization).toBe("Bearer k-github");
    const dc = fetches.find((f) => f.url.includes("discord.com"));
    expect((dc?.init?.headers as Record<string, string>).Authorization).toBe("Bot k-discord");

    const p = anthropicPrompt(fetches);
    expect(p.model).toBe("claude-sonnet-4-6");
    expect(p.system).toContain("## Custom addendum\nbe terse");
    expect(p.content).toContain("### Source: github(o/ok, o/bad, o/boom) (github)");
    expect(p.content).toContain("o/ok abcdef1 — first line");
    expect(p.content).toContain("[error] o/bad returned 404");
    expect(p.content).toContain("[error] o/boom: Error: net down");
    expect(p.content).toContain("[#42] u");
    expect(p.content).toContain("recent");
    expect(p.content).not.toContain("old");
    expect(p.content).toContain("a note");
    expect(p.content).toContain("(error: source type 'file_mtime' not yet implemented)");
    expect(p.content).toMatch(/### Source: github \(github\)\n\(error: TypeError/);

    expect(sql[0]?.sql).toContain("INSERT INTO digest_runs");
    expect(sql[0]?.args[1]).toBe("manual");
    const sub = sql.find((c) => c.sql.includes("substrate_entries"));
    expect(sub?.args.slice(1, 3)).toEqual(["the digest", "digest-morning"]);
    const done = finalUpdate(sql);
    expect(done?.sql).toContain("status = 'done'");
    expect(done?.args[1]).toBe("the digest");
  });

  test("a source with more than 30 items is truncated and items without ts print '?'", async () => {
    const { env } = fakeEnv({ ANTHROPIC_API_KEY: "k", DISCORD_BOT_TOKEN: "t" });
    const msgs = Array.from({ length: 35 }, (_, i) => ({
      id: String(i),
      content: `m${i}`,
      timestamp: new Date().toISOString(),
      author: { username: "u" },
    }));
    const fetches = stubFetch((url) => (url === ANTHROPIC ? anthropicText("d") : jsonResponse(msgs)));
    await run(env, {
      sources: [{ type: "discord_channel", config: { channel_id: "9", since_hours: 1 } }],
      delivery_targets: [{ type: "file", path: "/x" }],
    });
    const p = anthropicPrompt(fetches);
    expect(p.content).toContain("(... 5 more items truncated)");
    expect(p.content).not.toContain("m30");
  });

  test("an Anthropic answer with no content, or a text block with no text, yields an empty digest", async () => {
    const { env } = fakeEnv({ ANTHROPIC_API_KEY: "k" });
    stubFetch(() => jsonResponse({}));
    const r = await run(env, {
      sources: [{ type: "manual_note", config: { text: "x" } }],
      delivery_targets: [{ type: "file", path: "/x" }],
    });
    expect(r.body.digest).toBe("");

    stubFetch(() =>
      jsonResponse({
        content: [{ type: "tool_use" }, { type: "text" }, { type: "text", text: "kept" }],
      }),
    );
    const r2 = await run(env, {
      sources: [{ type: "manual_note", config: { text: "x" } }],
      delivery_targets: [{ type: "file", path: "/x" }],
    });
    expect(r2.body.digest).toBe("kept");
  });

  test("an Anthropic error fails the run: 500, and D1 records status failed with the reason", async () => {
    const { env, calls } = fakeEnv({ ANTHROPIC_API_KEY: "k" });
    stubFetch(() => new Response("overloaded", { status: 529 }));
    const r = await run(env, {
      sources: [{ type: "manual_note", config: { text: "x" } }],
      delivery_targets: [{ type: "file", path: "/x" }],
    });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: "Error: Anthropic 529: overloaded" });
    const failed = finalUpdate(calls);
    expect(failed?.sql).toContain("status = 'failed'");
    expect(failed?.args[1]).toBe("Error: Anthropic 529: overloaded");
  });
});

describe("source readers without credentials", () => {
  test("github without GITHUB_DIGEST_PAT and discord without a token or channel report errors", async () => {
    const { env } = fakeEnv({ ANTHROPIC_API_KEY: "k" });
    const fetches = stubFetch(() => anthropicText("d"));
    await run(env, {
      sources: [
        { type: "github", config: { repos: ["o/r"] } },
        { type: "github", config: {} },
        { type: "discord_channel", config: { channel_id: "1" } },
        { type: "discord_channel", config: { bot_token_secret: "ANTHROPIC_API_KEY" } },
      ],
      delivery_targets: [{ type: "file", path: "/x" }],
    });
    expect(fetches).toHaveLength(1);
    const p = anthropicPrompt(fetches);
    expect(p.content).toContain("### Source: o/r (github)\n(error: GITHUB_DIGEST_PAT secret not set");
    expect(p.content).toContain("(error: missing DISCORD_BOT_TOKEN secret or channel_id)");
    expect(p.content).toContain("(error: missing ANTHROPIC_API_KEY secret or channel_id)");
  });

  test("discord API error and network failure are reported per source", async () => {
    const { env } = fakeEnv({ ANTHROPIC_API_KEY: "k", DISCORD_BOT_TOKEN: "t" });
    const fetches = stubFetch((url) => {
      if (url.includes("/channels/1/")) return new Response("", { status: 403 });
      if (url.includes("/channels/2/")) throw new Error("reset");
      return anthropicText("d");
    });
    await run(env, {
      sources: [
        { type: "discord_channel", config: { channel_id: "1" } },
        { type: "discord_channel", config: { channel_id: "2" } },
      ],
      delivery_targets: [{ type: "file", path: "/x" }],
    });
    const p = anthropicPrompt(fetches);
    expect(p.content).toContain("(error: Discord API 403)");
    expect(p.content).toContain("(error: Error: reset)");
  });
});

describe("Workers AI synthesis", () => {
  test("model_pref workers_ai uses Workers AI even when an Anthropic key is set", async () => {
    const { env, aiRun } = fakeEnv({ ANTHROPIC_API_KEY: "k" });
    const fetches = stubFetch(() => new Response("ok"));
    const r = await run(env, {
      sources: [{ type: "manual_note", config: { text: "hello" } }],
      delivery_targets: [{ type: "file", path: "/x" }],
      model_pref: "workers_ai",
      custom_prompt_addendum: "add",
    });
    expect(r.body.digest).toBe("workers ai digest");
    expect(fetches).toHaveLength(0);
    const [model, input] = aiRun.mock.calls[0] as unknown as [
      string,
      { messages: { role: string; content: string }[] },
    ];
    expect(model).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(input.messages[0]!.content).toContain("## Custom addendum\nadd");
    expect(input.messages[1]!.content).toBe("Source manual: manual note :: hello");
  });

  test("no Anthropic key falls back to Workers AI; a missing response is an empty digest", async () => {
    const { env, aiRun } = fakeEnv();
    aiRun.mockResolvedValueOnce({});
    const r = await run(env, {
      sources: [{ type: "manual_note", config: { text: "hello" } }],
      delivery_targets: [{ type: "file", path: "/x" }],
    });
    expect(r.body.digest).toBe("");
    const [, input] = aiRun.mock.calls[0] as unknown as [string, { messages: { content: string }[] }];
    expect(input.messages[0]!.content).not.toContain("Custom addendum");
  });
});

describe("delivery targets", () => {
  async function deliver(env: Env, targets: unknown[]) {
    return run(env, { sources: [{ type: "manual_note", config: { text: "x" } }], delivery_targets: targets });
  }

  test("discord webhook: explicit url, chunked at 1900 characters", async () => {
    const { env, aiRun } = fakeEnv();
    aiRun.mockResolvedValueOnce({ response: "a".repeat(4000) });
    const fetches = stubFetch(() => new Response(null, { status: 204 }));
    const r = await deliver(env, [{ type: "discord_webhook", url: "https://hook.test/1" }]);
    expect(r.body.delivery).toEqual([{ target: "discord_webhook", ok: true }]);
    expect(fetches.map((f) => (JSON.parse(String(f.init?.body)) as { content: string }).content.length)).toEqual([
      1900, 1900, 200,
    ]);
  });

  test("discord webhook: env fallback url, an error status is reported, no url is reported", async () => {
    const { env } = fakeEnv({ DISCORD_DIGEST_WEBHOOK: "https://hook.test/env" });
    const fetches = stubFetch(() => new Response("", { status: 500 }));
    const r = await deliver(env, [{ type: "discord_webhook" }]);
    expect(fetches[0]?.url).toBe("https://hook.test/env");
    expect(r.body.delivery).toEqual([{ target: "discord_webhook", ok: false, err: "Error: Discord webhook 500" }]);

    const { env: bare } = fakeEnv();
    const r2 = await deliver(bare, [{ type: "discord_webhook" }]);
    expect(r2.body.delivery).toEqual([{ target: "discord_webhook", ok: false, err: "no webhook url" }]);
  });

  test("ntfy: explicit topic, env fallback, and no topic", async () => {
    const { env, aiRun } = fakeEnv({ NTFY_DIGEST_TOPIC: "envtopic" });
    aiRun.mockResolvedValue({ response: "b".repeat(5000) });
    const fetches = stubFetch(() => new Response("ok"));
    const r = await deliver(env, [{ type: "ntfy", topic: "mine" }, { type: "ntfy" }]);
    expect(r.body.delivery).toEqual([
      { target: "ntfy", ok: true },
      { target: "ntfy", ok: true },
    ]);
    expect(fetches.map((f) => f.url)).toEqual(["https://ntfy.sh/mine", "https://ntfy.sh/envtopic"]);
    expect(String(fetches[0]?.init?.body)).toHaveLength(4000);

    const { env: bare } = fakeEnv();
    const r2 = await deliver(bare, [{ type: "ntfy" }]);
    expect(r2.body.delivery).toEqual([{ target: "ntfy", ok: false, err: "no ntfy topic" }]);
  });

  test("an unknown target type yields no delivery result", async () => {
    const { env } = fakeEnv();
    const r = await deliver(env, [{ type: "carrier_pigeon" }]);
    expect(r.body.delivery).toEqual([]);
  });
});

describe("read handlers", () => {
  test("GET /digest/latest: 404 with no completed run, the row when there is one", async () => {
    const { env } = fakeEnv();
    const none = await handleDigestLatest(new Request("https://muckers.test/digest/latest"), env);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ ok: false, error: "no completed digest runs yet" });

    const { env: withRow, calls } = fakeEnv({}, ({ method }) => (method === "first" ? { id: "r1" } : undefined));
    const one = await handleDigestLatest(new Request("https://muckers.test/digest/latest"), withRow);
    expect(await one.json()).toEqual({ ok: true, run: { id: "r1" } });
    expect(calls[0]?.sql).toContain("WHERE status = 'done' ORDER BY started_at DESC LIMIT 1");
  });

  test("GET /digest/list returns the D1 rows", async () => {
    const { env } = fakeEnv({}, () => ({ results: [{ id: "a" }, { id: "b" }] }));
    const res = await handleDigestList(new Request("https://muckers.test/digest/list"), env);
    expect(await res.json()).toEqual({ ok: true, runs: [{ id: "a" }, { id: "b" }] });
  });

  test("GET /digest/schema describes the endpoints", async () => {
    const body = (await (await handleDigestSchema()).json()) as {
      ok: boolean;
      endpoints: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(Object.keys(body.endpoints)).toEqual(["POST /digest/run", "GET /digest/latest", "GET /digest/list"]);
  });
});

describe("runScheduledDigest (cron)", () => {
  test("no KV config: does nothing", async () => {
    const { env, calls } = fakeEnv();
    await runScheduledDigest(env);
    expect(calls).toHaveLength(0);
  });

  test("unparseable KV config: does nothing", async () => {
    const { env, calls, kv } = fakeEnv();
    kv.set("digest:cron_config", "{nope");
    await runScheduledDigest(env);
    expect(calls).toHaveLength(0);
  });

  test("valid config runs a digest triggered_by cron, overriding the stored trigger", async () => {
    const { env, calls, kv, aiRun } = fakeEnv();
    kv.set("digest:cron_config", JSON.stringify({ triggered_by: "manual", sources: [], delivery_targets: [] }));
    await runScheduledDigest(env);
    expect(calls[0]?.args[1]).toBe("cron");
    const [, input] = aiRun.mock.calls[0] as unknown as [string, { messages: { content: string }[] }];
    expect(input.messages[1]!.content).toBe("(no source items)");
    expect(finalUpdate(calls)?.sql).toContain("status = 'done'");
  });

  test("an empty raw pack to Anthropic sends the no-items placeholder", async () => {
    const { env, kv } = fakeEnv({ ANTHROPIC_API_KEY: "k" });
    kv.set("digest:cron_config", JSON.stringify({ sources: [], delivery_targets: [] }));
    const fetches = stubFetch(() => anthropicText("d"));
    await runScheduledDigest(env);
    expect(anthropicPrompt(fetches).content).toBe("(no source items)");
  });

  test("a failing run is swallowed (already recorded in D1)", async () => {
    const { env, calls, kv } = fakeEnv({ ANTHROPIC_API_KEY: "k" });
    kv.set("digest:cron_config", JSON.stringify({ sources: [], delivery_targets: [] }));
    stubFetch(() => new Response("bad", { status: 500 }));
    await expect(runScheduledDigest(env)).resolves.toBeUndefined();
    expect(finalUpdate(calls)?.sql).toContain("status = 'failed'");
  });
});
