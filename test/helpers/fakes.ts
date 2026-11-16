/**
 * fakes.ts — in-memory stand-ins for the Worker's bindings (D1, KV, AI) and for fetch.
 *
 * Why: the tests must exercise every handler without a Cloudflare account or a network. Each fake records
 * what the code asked for (SQL + bound values, fetch URLs + bodies) so a test asserts behavior, and answers
 * from a handler the test supplies so a test can steer each branch.
 */
import { vi } from "vitest";
import type { Env } from "../../src/common";

export interface SqlCall {
  sql: string;
  args: unknown[];
  method: "first" | "all" | "run";
}

export type SqlHandler = (call: SqlCall) => unknown;

export function fakeDb(handler: SqlHandler = () => undefined): { db: D1Database; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const answer = async (method: SqlCall["method"]) => {
        const call = { sql, args, method };
        calls.push(call);
        const out = handler(call);
        if (out !== undefined) return out;
        if (method === "first") return null;
        if (method === "all") return { results: [] };
        return { success: true };
      };
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        first: () => answer("first"),
        all: () => answer("all"),
        run: () => answer("run"),
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, calls };
}

export function fakeEnv(overrides: Partial<Env> = {}, handler?: SqlHandler) {
  const { db, calls } = fakeDb(handler);
  const kv = new Map<string, string>();
  const aiRun = vi.fn(async () => ({ response: "  workers ai digest  " }) as unknown);
  const env: Env = {
    DB: db,
    PREFS: { get: async (k: string) => kv.get(k) ?? null } as unknown as KVNamespace,
    AI: { run: aiRun } as unknown as Ai,
    PACK_TOKEN: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
  return { env, calls, kv, aiRun };
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Stub global fetch; the handler decides each response. vitest's unstubGlobals restores it after each test. */
export function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  return calls;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export function anthropicText(text: string): Response {
  return jsonResponse({ content: [{ type: "text", text }] });
}

export function post(path: string, body?: unknown): Request {
  return new Request(`https://muckers.test${path}`, {
    method: "POST",
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
