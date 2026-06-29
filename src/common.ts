/**
 * common.ts — shared response helpers + env type.
 */

export interface Env {
  DB: D1Database;
  PREFS: KVNamespace;
  AI: Ai;
  PACK_TOKEN: string;
  ANTHROPIC_API_KEY?: string;
  GITHUB_DIGEST_PAT?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DIGEST_WEBHOOK?: string;
  NTFY_DIGEST_TOPIC?: string;
}

export function corsHeaders(): Headers {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Pack-Token");
  return h;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...Object.fromEntries(corsHeaders()) },
  });
}

export function unauthorized(): Response {
  return json({ error: "unauthorized", message: "set X-Pack-Token header" }, 401);
}

export function notFound(path: string): Response {
  return json({ error: "not_found", path }, 404);
}
