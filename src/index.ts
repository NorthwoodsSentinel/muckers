/**
 * muckers — Edison-shaped substrate for operators
 *
 * Single Worker exposing two endpoint families plus a cron:
 *   /digest/run        — fire a digest synthesis (POST)
 *   /digest/latest     — most recent digest (GET)
 *   /digest/list       — last 20 digest run metadata (GET)
 *   /digest/schema     — endpoint shapes (GET)
 *   /organizer/scan    — scan digest archive for repeated tool shapes (POST)
 *   /organizer/proposals — list rule-of-three proposals (GET)
 *   /organizer/proposals/:id/{acknowledge|formalize|dismiss} — proposal lifecycle (POST)
 *   /organizer/schema  — endpoint shapes (GET)
 *   /                  — service info + module status (GET)
 *
 * The two Workers (digest + organizer) compose with three file primitives
 * (STANDING_RULES.md, AGENDA.md, DualMode skill). The five together are the
 * muckers toolkit — see HISTORY.md for why it's named after Edison's team.
 */

import { corsHeaders, json, unauthorized, notFound, Env } from "./common";
import {
  handleDigestRun,
  handleDigestLatest,
  handleDigestList,
  handleDigestSchema,
  runScheduledDigest,
} from "./digest";
import {
  handleOrganizerScan,
  handleOrganizerProposals,
  handleOrganizerAction,
  handleOrganizerSchema,
} from "./organizer";

async function info(env: Env): Promise<Response> {
  let digestCount = 0;
  let proposalCount = 0;
  try {
    const d = await env.DB.prepare(`SELECT COUNT(*) as n FROM digest_runs WHERE status = 'done'`).first<{ n: number }>();
    digestCount = d?.n ?? 0;
    const p = await env.DB.prepare(`SELECT COUNT(*) as n FROM tool_proposals WHERE status = 'open' AND hit_count >= 3`).first<{ n: number }>();
    proposalCount = p?.n ?? 0;
  } catch {
    /* DB may not be migrated yet */
  }
  return json({
    service: "muckers",
    version: "0.1.0",
    purpose:
      "Edison-shaped substrate for operators who run a many-agent fleet and need the operational discipline that 14 lab assistants gave Edison.",
    history: "See HISTORY.md for why this is named after Edison's team.",
    modules: {
      digest: {
        paths: [
          "POST /digest/run",
          "GET /digest/latest",
          "GET /digest/list",
          "GET /digest/schema",
        ],
        completed_runs: digestCount,
        analog: "The 1880 daily journal Edison's office staff kept of laboratory work.",
      },
      organizer: {
        paths: [
          "POST /organizer/scan",
          "GET /organizer/proposals",
          "POST /organizer/proposals/:id/acknowledge",
          "POST /organizer/proposals/:id/formalize",
          "POST /organizer/proposals/:id/dismiss",
          "GET /organizer/schema",
        ],
        open_proposals_at_rule_of_three: proposalCount,
        analog: "Edison's rule-of-three for formalizing recurring problems into named tools.",
      },
    },
    templates: ["STANDING_RULES.md (the constitutional layer)", "AGENDA.md (the cross-session ticket store)"],
    skills: ["dual-mode (the parallel-tracked-cognition protocol)"],
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && (path === "/" || path === "")) {
      return info(env);
    }

    // Public schema endpoints (no auth)
    if (method === "GET" && path === "/digest/schema") return await handleDigestSchema(request);
    if (method === "GET" && path === "/organizer/schema") return await handleOrganizerSchema(request);

    const token = request.headers.get("X-Pack-Token");
    if (!token || token !== env.PACK_TOKEN) {
      return unauthorized();
    }

    try {
      if (method === "POST" && path === "/digest/run") return await handleDigestRun(request, env);
      if (method === "GET" && path === "/digest/latest") return await handleDigestLatest(request, env);
      if (method === "GET" && path === "/digest/list") return await handleDigestList(request, env);
      if (method === "POST" && path === "/organizer/scan") return await handleOrganizerScan(request, env);
      if (method === "GET" && path === "/organizer/proposals") return await handleOrganizerProposals(request, env);

      const proposalAction = path.match(
        /^\/organizer\/proposals\/([a-f0-9-]+)\/(acknowledge|formalize|dismiss)$/,
      );
      if (method === "POST" && proposalAction) {
        return await handleOrganizerAction(
          request,
          env,
          proposalAction[1]!,
          proposalAction[2]! as "acknowledge" | "formalize" | "dismiss",
        );
      }
    } catch (err) {
      return json({ error: "internal_error", detail: String(err) }, 500);
    }

    return notFound(path);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledDigest(env));
  },
};
