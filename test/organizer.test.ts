/**
 * organizer.test.ts — the rule-of-three organizer (src/organizer.ts): scan, proposal upsert, listing,
 * the proposal lifecycle and the schema.
 *
 * Why: the organizer turns model output into D1 rows; these tests drive every branch with a stubbed Anthropic
 * response and a fake D1, asserting what lands in the database and what the caller is told.
 */
import { describe, expect, test } from "vitest";
import {
  handleOrganizerAction,
  handleOrganizerProposals,
  handleOrganizerScan,
  handleOrganizerSchema,
} from "../src/organizer";
import type { Env } from "../src/common";
import { anthropicText, fakeEnv, jsonResponse, post, stubFetch, type SqlHandler } from "./helpers/fakes";

const DIGESTS = [
  { id: "d1", digest_text: "x".repeat(120), started_at: "2026-11-15T12:00:00Z" },
  { id: "d2", digest_text: "y".repeat(120), started_at: "2026-11-14T12:00:00Z" },
];

/** D1 answers: the digest window query returns `digests`; the shape lookup returns `existing`. */
function scanDb(digests: unknown, existing: (sig: string) => unknown = () => null): SqlHandler {
  return ({ sql, args, method }) => {
    if (sql.includes("FROM digest_runs")) return { results: digests };
    if (sql.includes("WHERE shape_signature = ?") && method === "first") return existing(String(args[0]));
    return undefined;
  };
}

async function scan(env: Env, body?: unknown) {
  const res = await handleOrganizerScan(post("/organizer/scan", body), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const shapesReply = (shapes: unknown) => anthropicText(`Here you go:\n${JSON.stringify({ shapes })}\nthanks`);

describe("POST /organizer/scan preconditions", () => {
  test("no ANTHROPIC_API_KEY -> 400", async () => {
    const { env } = fakeEnv();
    const r = await scan(env);
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("ANTHROPIC_API_KEY secret required");
  });

  test("no digests in the window (default 168 hours); a missing results array counts as none", async () => {
    const { env, calls } = fakeEnv({ ANTHROPIC_API_KEY: "k" }, scanDb([]));
    const r = await scan(env, "not json");
    expect(r.body).toEqual({ ok: true, message: "no digests in scan window", since_hours: 168 });
    expect(calls[0]?.sql).toContain("length(digest_text) > 100");

    const { env: env2 } = fakeEnv({ ANTHROPIC_API_KEY: "k" }, scanDb(undefined));
    expect((await scan(env2)).body.message).toBe("no digests in scan window");
  });

  test("one digest is not enough to cross-reference; since_hours is honored", async () => {
    const { env } = fakeEnv({ ANTHROPIC_API_KEY: "k" }, scanDb([DIGESTS[0]]));
    const r = await scan(env, { since_hours: 24 });
    expect(r.body).toEqual({
      ok: true,
      message: "only 1 digest in window — need at least 2 for cross-reference",
      since_hours: 24,
    });
  });
});

describe("POST /organizer/scan with the scanner", () => {
  test("new shapes are inserted with deduplicated run ids and at most five snippets", async () => {
    const { env, calls } = fakeEnv({ ANTHROPIC_API_KEY: "k" }, scanDb(DIGESTS));
    const fetches = stubFetch(() =>
      shapesReply([
        {
          shape_signature: "queue-poller",
          shape_summary: "polls a queue",
          occurrences: [
            { digest_id: "d1", snippet: "s1" },
            { digest_id: "d1", snippet: "s2" },
            { digest_id: "d2", snippet: "s3" },
            { digest_id: "d2", snippet: "s4" },
            { digest_id: "d2", snippet: "s5" },
            { digest_id: "d2", snippet: "s6" },
          ],
        },
      ]),
    );
    const r = await scan(env);
    expect(r.body).toEqual({
      ok: true,
      scanned_digests: 2,
      shapes_detected: 1,
      summary: [{ shape: "queue-poller", status: "new", hit_count: 2 }],
    });
    const sent = JSON.parse(String(fetches[0]?.init?.body)) as { max_tokens: number; messages: { content: string }[] };
    expect(sent.max_tokens).toBe(4000);
    expect(sent.messages[0]!.content).toContain("### digest_id=d1 (2026-11-15)");
    const insert = calls.find((c) => c.sql.includes("INSERT INTO tool_proposals"));
    expect(insert?.args.slice(2)).toEqual([
      "queue-poller",
      "polls a queue",
      2,
      '["d1","d2"]',
      '["s1","s2","s3","s4","s5"]',
    ]);
  });

  test("an existing shape gains only unseen runs, snippets capped at five; no new run means no write", async () => {
    const existing = (sig: string) =>
      sig === "seen"
        ? { id: "p1", hit_count: 2, hit_run_ids_json: '["d1"]', example_snippets_json: '["a","b","c","d"]' }
        : { id: "p2", hit_count: 3, hit_run_ids_json: '["d1","d2"]', example_snippets_json: "[]" };
    const { env, calls } = fakeEnv({ ANTHROPIC_API_KEY: "k" }, scanDb(DIGESTS, existing));
    stubFetch(() =>
      shapesReply([
        {
          shape_signature: "seen",
          shape_summary: "s",
          occurrences: [
            { digest_id: "d1", snippet: "dup" },
            { digest_id: "d2", snippet: "e" },
            { digest_id: "d3", snippet: "f" },
          ],
        },
        { shape_signature: "stale", shape_summary: "s", occurrences: [{ digest_id: "d2", snippet: "z" }] },
      ]),
    );
    const r = await scan(env);
    expect(r.body.summary).toEqual([
      { shape: "seen", status: "updated", hit_count: 4 },
      { shape: "stale", status: "updated", hit_count: 3 },
    ]);
    const updates = calls.filter((c) => c.sql.startsWith("UPDATE tool_proposals"));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.args).toEqual([4, '["d1","d2","d3"]', '["a","b","c","d","e"]', "p1"]);
  });

  test("a scanner reply whose shapes is not an array yields no shapes", async () => {
    const { env } = fakeEnv({ ANTHROPIC_API_KEY: "k" }, scanDb(DIGESTS));
    stubFetch(() => anthropicText('{"shapes": "none"}'));
    expect((await scan(env)).body).toEqual({ ok: true, scanned_digests: 2, shapes_detected: 0, summary: [] });
  });

  test("Anthropic error -> 500 with the status and body", async () => {
    const { env } = fakeEnv({ ANTHROPIC_API_KEY: "k" }, scanDb(DIGESTS));
    stubFetch(() => new Response("rate limited", { status: 429 }));
    const r = await scan(env);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: "Error: Anthropic 429: rate limited" });
  });

  test("a reply with no JSON object -> 500; a reply with no content counts as no JSON", async () => {
    const { env } = fakeEnv({ ANTHROPIC_API_KEY: "k" }, scanDb(DIGESTS));
    stubFetch(() => jsonResponse({ content: [{ type: "text" }, { type: "image" }] }));
    const r = await scan(env);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("Error: scanner output did not contain JSON");

    stubFetch(() => jsonResponse({}));
    expect((await scan(env)).body.error).toBe("Error: scanner output did not contain JSON");
  });
});

describe("GET /organizer/proposals", () => {
  const row = {
    id: "p1",
    detected_at: "2026-11-01",
    shape_signature: "s",
    shape_summary: "sum",
    hit_count: 3,
    hit_run_ids_json: '["d1"]',
    example_snippets_json: '["x"]',
    status: "open",
  };

  test("defaults to status open and min_hits 3; absent lifecycle fields become null", async () => {
    const { env, calls } = fakeEnv({}, () => ({ results: [row, { ...row, id: "p2", hit_count: 1 }] }));
    const res = await handleOrganizerProposals(new Request("https://muckers.test/organizer/proposals"), env);
    const body = (await res.json()) as { filter: unknown; proposals: unknown[]; rule_of_three_eligible: number };
    expect(calls[0]?.args).toEqual(["open", 3]);
    expect(body.filter).toEqual({ status: "open", min_hits: 3 });
    expect(body.rule_of_three_eligible).toBe(1);
    expect(body.proposals[0]).toEqual({
      id: "p1",
      detected_at: "2026-11-01",
      shape_signature: "s",
      shape_summary: "sum",
      hit_count: 3,
      hit_run_ids: ["d1"],
      example_snippets: ["x"],
      status: "open",
      acknowledged_at: null,
      formalized_at: null,
      formalized_as: null,
      dismissed_at: null,
    });
  });

  test("query parameters filter; present lifecycle fields pass through; missing results is empty", async () => {
    const full = { ...row, acknowledged_at: "a", formalized_at: "f", formalized_as: "tool", dismissed_at: "d" };
    const { env, calls } = fakeEnv({}, () => ({ results: [full] }));
    const res = await handleOrganizerProposals(
      new Request("https://muckers.test/organizer/proposals?status=formalized&min_hits=1"),
      env,
    );
    const body = (await res.json()) as { proposals: Record<string, unknown>[] };
    expect(calls[0]?.args).toEqual(["formalized", 1]);
    expect(body.proposals[0]).toMatchObject({
      acknowledged_at: "a",
      formalized_at: "f",
      formalized_as: "tool",
      dismissed_at: "d",
    });

    const { env: empty } = fakeEnv({}, () => ({}));
    const res2 = await handleOrganizerProposals(new Request("https://muckers.test/organizer/proposals"), empty);
    expect(((await res2.json()) as { proposals: unknown[] }).proposals).toEqual([]);
  });
});

describe("proposal lifecycle", () => {
  test("acknowledge and dismiss set their status and timestamp", async () => {
    for (const [action, column] of [
      ["acknowledge", "acknowledged_at"],
      ["dismiss", "dismissed_at"],
    ] as const) {
      const { env, calls } = fakeEnv();
      const res = await handleOrganizerAction(post("/x"), env, "p1", action);
      expect(await res.json()).toEqual({ ok: true, proposal_id: "p1", action });
      expect(calls[0]?.sql).toContain(column);
      expect(calls[0]?.args[1]).toBe("p1");
    }
  });

  test("formalize requires formalized_as, then records it", async () => {
    const { env, calls } = fakeEnv();
    const bad = await handleOrganizerAction(post("/x", "garbage"), env, "p1", "formalize");
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(0);

    const ok = await handleOrganizerAction(post("/x", { formalized_as: "queue-poller-skill" }), env, "p1", "formalize");
    expect(ok.status).toBe(200);
    expect(calls[0]?.sql).toContain("status = 'formalized'");
    expect(calls[0]?.args.slice(1)).toEqual(["queue-poller-skill", "p1"]);
  });

  test("an action outside the three writes nothing and still answers ok", async () => {
    const { env, calls } = fakeEnv();
    const res = await handleOrganizerAction(post("/x"), env, "p1", "other" as "dismiss");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});

test("GET /organizer/schema describes the endpoints and the rule of three", async () => {
  const body = (await (await handleOrganizerSchema()).json()) as {
    ok: boolean;
    endpoints: Record<string, unknown>;
    rule_of_three: { description: string };
  };
  expect(body.ok).toBe(true);
  expect(Object.keys(body.endpoints)).toHaveLength(5);
  expect(body.rule_of_three.description).toContain("hit_count >= 3");
});
