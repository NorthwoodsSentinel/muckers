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

export function notConfigured(): Response {
  return json({ error: "not_configured", message: "set PACK_TOKEN with wrangler secret put" }, 503);
}

// kintsugi: the door shipped with its key taped to the frame —
//   now an unset or borrowed key opens nothing,
//   and the lock no longer tells the hand how near it came.
export function packTokenUsable(configured: string | undefined): configured is string {
  return typeof configured === "string" && configured.length >= 32 && !configured.startsWith("CHANGE-ME");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Constant-time comparison via the runtime's crypto.subtle.timingSafeEqual (Workers).
 * Both sides are hashed to 32 bytes first, so length never leaks. A runtime without
 * timingSafeEqual fails closed rather than falling back to a JS loop the JIT could shortcut.
 */
export async function tokenMatches(presented: string, configured: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(configured)]);
  if (typeof crypto.subtle.timingSafeEqual !== "function") return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
