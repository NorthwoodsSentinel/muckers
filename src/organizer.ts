/**
 * organizer.ts — rule-of-three tool-shape detector
 *
 * Reads the digest archive (digest_runs.digest_text from the muckers digest
 * tool), identifies repeated tool-shape mentions via Anthropic semantic
 * categorization, increments hit-counts in tool_proposals, surfaces proposals
 * when hit_count >= 3.
 *
 * Edison analog: the rule-of-three pattern names a discipline Edison and his
 * muckers practiced — when the same problem-shape appeared three times in
 * different experiments, that's when a named tool or sub-procedure earned its
 * place in the standing kit. Before three occurrences, a one-off was just a
 * one-off; after three, it was a generalizable solution worth keeping.
 *
 * The organizer enforces that discipline by waiting until the third
 * occurrence accumulates across the digest archive, then surfacing the
 * shape for the operator's decision: acknowledge, formalize into a real
 * tool, or dismiss as not-worth-pursuing.
 */

import { json, Env } from "./common";

interface ToolProposal {
  id: string;
  detected_at: string;
  shape_signature: string;
  shape_summary: string;
  hit_count: number;
  hit_run_ids: string[];
  example_snippets: string[];
  status: "open" | "acknowledged" | "formalized" | "dismissed";
}

const SCAN_SYSTEM_PROMPT = `You are the operator's tool-shape detector.

You will be given the operator's digest archive — a series of daily digests describing what they worked on, what was open mid-flight, and patterns worth surfacing. Your job: identify TOOL SHAPES that appear across multiple digests. A "tool shape" is a kind of solution the operator builds or wishes for, named at a level of abstraction that lets you match it across different incidents.

Examples of valid tool shapes:
- "queue-poller" — a thing that polls a queue (could be GH issues, email, RSS) and dispatches work
- "context-injector" — a thing that pre-loads context into an agent when the operator switches machines or sessions
- "diff-verifier" — a thing that validates a proposed diff against a manifest before commit
- "auto-summarizer" — a thing that summarizes long content into something the operator can act on

Examples of INVALID tool shapes (too specific):
- "fix the bivouac parser bug" — that's one fix, not a shape
- "use the Anthropic API" — that's a primitive, not a tool shape

For each shape you detect that appears in 2+ digest entries (you can also surface single-occurrence shapes if they're particularly notable), output a structured JSON object with these fields:

\`\`\`json
{
  "shapes": [
    {
      "shape_signature": "kebab-case-stable-identifier",
      "shape_summary": "one-line plain English description (what the shape does)",
      "occurrences": [
        {
          "digest_id": "<the digest_runs.id you saw it in>",
          "snippet": "the actual sentence or phrase from the digest that matched (verbatim, ≤300 chars)"
        }
      ]
    }
  ]
}
\`\`\`

Be conservative. False positives (claiming a shape was seen when it wasn't) erode the operator's trust in the organizer. False negatives (missing a real recurrence) are recoverable in the next scan. When unsure, don't surface.`;

function nowIso(): string {
  return new Date().toISOString();
}

interface ScannerOccurrence {
  digest_id: string;
  snippet: string;
}
interface ScannerShape {
  shape_signature: string;
  shape_summary: string;
  occurrences: ScannerOccurrence[];
}

async function scanDigestsWithAnthropic(
  digests: { id: string; digest_text: string; started_at: string }[],
  apiKey: string,
): Promise<ScannerShape[]> {
  const packed = digests
    .map(
      (d) => `### digest_id=${d.id} (${d.started_at.slice(0, 10)})\n${d.digest_text}`,
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
      max_tokens: 4000,
      system: SCAN_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `Here are the operator's digests from the last scan window:\n\n${packed}\n\n` +
            `Output JSON only, no prose preamble.`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("scanner output did not contain JSON");
  const parsed = JSON.parse(jsonMatch[0]) as { shapes: ScannerShape[] };
  return Array.isArray(parsed.shapes) ? parsed.shapes : [];
}

async function upsertProposal(
  env: Env,
  shape: ScannerShape,
): Promise<{ created: boolean; hit_count: number }> {
  const existing = await env.DB.prepare(
    `SELECT id, hit_count, hit_run_ids_json, example_snippets_json FROM tool_proposals WHERE shape_signature = ?`,
  )
    .bind(shape.shape_signature)
    .first<{
      id: string;
      hit_count: number;
      hit_run_ids_json: string;
      example_snippets_json: string;
    }>();

  if (existing) {
    const existingRuns = new Set<string>(JSON.parse(existing.hit_run_ids_json));
    const existingSnippets: string[] = JSON.parse(existing.example_snippets_json);

    let newRunCount = 0;
    for (const occ of shape.occurrences) {
      if (!existingRuns.has(occ.digest_id)) {
        existingRuns.add(occ.digest_id);
        newRunCount++;
        if (existingSnippets.length < 5) existingSnippets.push(occ.snippet);
      }
    }
    if (newRunCount === 0) return { created: false, hit_count: existing.hit_count };

    const newHitCount = existing.hit_count + newRunCount;
    await env.DB.prepare(
      `UPDATE tool_proposals SET hit_count = ?, hit_run_ids_json = ?, example_snippets_json = ? WHERE id = ?`,
    )
      .bind(
        newHitCount,
        JSON.stringify([...existingRuns]),
        JSON.stringify(existingSnippets),
        existing.id,
      )
      .run();
    return { created: false, hit_count: newHitCount };
  }

  const id = crypto.randomUUID();
  const runs = [...new Set(shape.occurrences.map((o) => o.digest_id))];
  const snippets = shape.occurrences.slice(0, 5).map((o) => o.snippet);
  await env.DB.prepare(
    `INSERT INTO tool_proposals
       (id, detected_at, shape_signature, shape_summary, hit_count, hit_run_ids_json, example_snippets_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
  )
    .bind(
      id,
      nowIso(),
      shape.shape_signature,
      shape.shape_summary,
      runs.length,
      JSON.stringify(runs),
      JSON.stringify(snippets),
    )
    .run();
  return { created: true, hit_count: runs.length };
}

export async function handleOrganizerScan(
  req: Request,
  env: Env,
): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return json(
      {
        ok: false,
        error: "ANTHROPIC_API_KEY secret required for scanner. Set via `wrangler secret put`.",
      },
      400,
    );
  }

  const body = (await req.json().catch(() => ({}))) as { since_hours?: number };
  const sinceHours = body.since_hours ?? 168; // default 7 days
  const sinceDate = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  const digests = await env.DB.prepare(
    `SELECT id, digest_text, started_at FROM digest_runs
     WHERE status = 'done' AND started_at >= ? AND digest_text IS NOT NULL AND length(digest_text) > 100
     ORDER BY started_at DESC LIMIT 30`,
  )
    .bind(sinceDate)
    .all<{ id: string; digest_text: string; started_at: string }>();

  if (!digests.results || digests.results.length === 0) {
    return json({ ok: true, message: "no digests in scan window", since_hours: sinceHours });
  }
  if (digests.results.length < 2) {
    return json({
      ok: true,
      message: "only 1 digest in window — need at least 2 for cross-reference",
      since_hours: sinceHours,
    });
  }

  let shapes: ScannerShape[];
  try {
    shapes = await scanDigestsWithAnthropic(digests.results, env.ANTHROPIC_API_KEY);
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }

  const summary: { shape: string; status: string; hit_count: number }[] = [];
  for (const s of shapes) {
    const result = await upsertProposal(env, s);
    summary.push({
      shape: s.shape_signature,
      status: result.created ? "new" : "updated",
      hit_count: result.hit_count,
    });
  }

  return json({
    ok: true,
    scanned_digests: digests.results.length,
    shapes_detected: shapes.length,
    summary,
  });
}

export async function handleOrganizerProposals(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "open";
  const minHits = parseInt(url.searchParams.get("min_hits") ?? "3", 10);

  const result = await env.DB.prepare(
    `SELECT id, detected_at, shape_signature, shape_summary, hit_count,
            hit_run_ids_json, example_snippets_json, status,
            acknowledged_at, formalized_at, formalized_as, dismissed_at
     FROM tool_proposals
     WHERE status = ? AND hit_count >= ?
     ORDER BY hit_count DESC, detected_at ASC`,
  )
    .bind(status, minHits)
    .all<{
      id: string;
      detected_at: string;
      shape_signature: string;
      shape_summary: string;
      hit_count: number;
      hit_run_ids_json: string;
      example_snippets_json: string;
      status: string;
      acknowledged_at?: string;
      formalized_at?: string;
      formalized_as?: string;
      dismissed_at?: string;
    }>();

  const proposals = (result.results ?? []).map((r) => ({
    id: r.id,
    detected_at: r.detected_at,
    shape_signature: r.shape_signature,
    shape_summary: r.shape_summary,
    hit_count: r.hit_count,
    hit_run_ids: JSON.parse(r.hit_run_ids_json),
    example_snippets: JSON.parse(r.example_snippets_json),
    status: r.status,
    acknowledged_at: r.acknowledged_at ?? null,
    formalized_at: r.formalized_at ?? null,
    formalized_as: r.formalized_as ?? null,
    dismissed_at: r.dismissed_at ?? null,
  }));

  return json({
    ok: true,
    filter: { status, min_hits: minHits },
    proposals,
    rule_of_three_eligible: proposals.filter((p) => p.hit_count >= 3).length,
  });
}

export async function handleOrganizerAction(
  req: Request,
  env: Env,
  proposalId: string,
  action: "acknowledge" | "formalize" | "dismiss",
): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { formalized_as?: string };
  const now = nowIso();

  if (action === "acknowledge") {
    await env.DB.prepare(
      `UPDATE tool_proposals SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?`,
    )
      .bind(now, proposalId)
      .run();
  } else if (action === "formalize") {
    if (!body.formalized_as) {
      return json({ ok: false, error: "formalized_as field required (the tool/skill name)" }, 400);
    }
    await env.DB.prepare(
      `UPDATE tool_proposals SET status = 'formalized', formalized_at = ?, formalized_as = ? WHERE id = ?`,
    )
      .bind(now, body.formalized_as, proposalId)
      .run();
  } else if (action === "dismiss") {
    await env.DB.prepare(
      `UPDATE tool_proposals SET status = 'dismissed', dismissed_at = ? WHERE id = ?`,
    )
      .bind(now, proposalId)
      .run();
  }

  return json({ ok: true, proposal_id: proposalId, action });
}

export async function handleOrganizerSchema(_req: Request): Promise<Response> {
  return json({
    ok: true,
    endpoints: {
      "POST /organizer/scan": {
        body: { since_hours: "int, default 168 (7 days)" },
        returns: "scan summary — new shapes detected + hit-count updates",
        requires: "ANTHROPIC_API_KEY secret + at least 2 completed digests in window",
      },
      "GET /organizer/proposals": {
        query: { status: "open | acknowledged | formalized | dismissed (default open)", min_hits: "int, default 3" },
        returns: "list of tool proposals matching filter",
      },
      "POST /organizer/proposals/:id/acknowledge": { returns: "marks proposal as seen, doesn't auto-formalize" },
      "POST /organizer/proposals/:id/formalize": {
        body: { formalized_as: "string (the tool/skill name that resulted)" },
        returns: "marks proposal as resolved by building the tool",
      },
      "POST /organizer/proposals/:id/dismiss": { returns: "marks proposal as not-worth-pursuing" },
    },
    rule_of_three: {
      description:
        "Proposals with hit_count >= 3 are surfaced by default. Below 3 require ?min_hits=N to retrieve.",
      reasoning:
        "The operator's stated discipline (Wally call 2026-06-28 00:38): 'I don't make a tool unless I run into the same problem three times.' The organizer enforces that discipline by waiting until 3 occurrences accumulate before surfacing.",
    },
  });
}
