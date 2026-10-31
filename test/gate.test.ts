/**
 * gate.test.ts — adversarial cases for the PACK_TOKEN gate.
 *
 * Cases 1–28 were written by Codex (design review, NOR-155, 2026-10-31) and are
 * kept verbatim in intent and expectation; only the harness around them is ours.
 */
import { describe, expect, test } from "bun:test";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { tokenMatches, type Env } from "../src/common";

// Bun lacks the Workers-only crypto.subtle.timingSafeEqual; supply node's for the suite.
// The gate itself never falls back to a JS comparison (see the fail-closed case below).
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
const nativeTimingSafeEqual = subtle.timingSafeEqual;
subtle.timingSafeEqual = (a, b) => timingSafeEqual(a, b);

const S = "0123456789abcdef0123456789abcdef";
const BASE = "https://muckers.test";

/** D1/KV/AI stubs: enough for handlers to answer, never enough to reach a real service. */
function stubEnv(packToken: string | undefined): Env {
  const stmt = {
    bind: () => stmt,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ success: true }),
  };
  return {
    DB: { prepare: () => stmt } as unknown as D1Database,
    PREFS: { get: async () => null, put: async () => {} } as unknown as KVNamespace,
    AI: { run: async () => ({ response: "" }) } as unknown as Ai,
    PACK_TOKEN: packToken as string,
  };
}

async function call(
  packToken: string | undefined,
  method: string,
  path: string,
  headers: [string, string][] = [],
): Promise<Response> {
  const h = new Headers();
  for (const [k, v] of headers) h.append(k, v);
  return worker.fetch(new Request(BASE + path, { method, headers: h }), stubEnv(packToken));
}

async function errorOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: string }).error;
}

const passedGate = (status: number) => status !== 401 && status !== 503;

describe("PACK_TOKEN gate (Codex adversarial cases)", () => {
  test("1: unset config, no header -> 503 not_configured", async () => {
    const r = await call(undefined, "GET", "/digest/latest");
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toBe("not_configured");
  });

  test("2: unset config, header 'undefined' -> 503 not_configured", async () => {
    const r = await call(undefined, "GET", "/digest/latest", [["X-Pack-Token", "undefined"]]);
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toBe("not_configured");
  });

  test("3: empty config, POST /digest/run -> 503", async () => {
    const r = await call("", "POST", "/digest/run");
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toBe("not_configured");
  });

  test("4: 31-char config with matching header -> 503", async () => {
    const t = "1234567890123456789012345678901";
    const r = await call(t, "GET", "/organizer/proposals", [["X-Pack-Token", t]]);
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toBe("not_configured");
  });

  test("5: 32-char config with matching header passes the gate", async () => {
    const t = "12345678901234567890123456789012";
    const r = await call(t, "GET", "/organizer/proposals", [["X-Pack-Token", t]]);
    expect(passedGate(r.status)).toBe(true);
  });

  test("6: published placeholder never authorizes -> 503", async () => {
    const t = "CHANGE-ME-RUN-openssl-rand-hex-32";
    const r = await call(t, "GET", "/digest/latest", [["X-Pack-Token", t]]);
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toBe("not_configured");
  });

  test("7: long CHANGE-ME prefix -> 503", async () => {
    const t = "CHANGE-ME" + "A".repeat(64);
    const r = await call(t, "POST", "/organizer/scan", [["X-Pack-Token", t]]);
    expect(r.status).toBe(503);
    expect(await errorOf(r)).toBe("not_configured");
  });

  test("8: valid config, no header -> 401 unauthorized", async () => {
    const r = await call(S, "GET", "/digest/latest");
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toBe("unauthorized");
  });

  test("9: one-character mismatch -> 401", async () => {
    const r = await call(S, "GET", "/digest/latest", [["X-Pack-Token", "0123456789abcdef0123456789abcdee"]]); // gitleaks:allow (test fixture, not a credential)
    expect(r.status).toBe(401);
  });

  // WAIVER (P24, inline): the Fetch spec strips leading/trailing ASCII whitespace from
  // header values before the Worker sees them, so "S " arrives as "S" and authorizes.
  // The gate cannot observe the space; the caller still had to hold S, so nothing is
  // bypassed. Kept verbatim as test.failing so a runtime change flips it loudly.
  test.failing("10: trailing space is not trimmed into a match -> 401", async () => {
    const r = await call(S, "GET", "/digest/latest", [["X-Pack-Token", `${S} `]]);
    expect(r.status).toBe(401);
  });

  // Not a Codex case: a non-ASCII trailing space survives header normalization.
  test("10b: trailing no-break space -> 401", async () => {
    const r = await call(S, "GET", "/digest/latest", [["X-Pack-Token", `${S} `]]);
    expect(r.status).toBe(401);
  });

  test("11: duplicate raw headers (wrong, then valid) -> 401", async () => {
    const r = await call(S, "GET", "/digest/latest", [
      ["X-Pack-Token", "wrong"],
      ["X-Pack-Token", S],
    ]);
    expect(r.status).toBe(401);
  });

  test("12: comma-list 'wrong, S' -> 401", async () => {
    const r = await call(S, "GET", "/digest/latest", [["X-Pack-Token", `wrong, ${S}`]]);
    expect(r.status).toBe(401);
  });

  test("13: comma-list 'S, wrong' -> 401", async () => {
    const r = await call(S, "GET", "/digest/latest", [["X-Pack-Token", `${S}, wrong`]]);
    expect(r.status).toBe(401);
  });

  test("14: lowercase header name passes the gate", async () => {
    const r = await call(S, "GET", "/digest/latest", [["x-pack-token", S]]);
    expect(passedGate(r.status)).toBe(true);
  });

  test("15: GET / stays public -> 200", async () => {
    const r = await call(S, "GET", "/");
    expect(r.status).toBe(200);
  });

  test("16: GET /digest/schema public even when unconfigured -> 200", async () => {
    const r = await call(undefined, "GET", "/digest/schema");
    expect(r.status).toBe(200);
  });

  test("17: GET /organizer/schema public even when unconfigured -> 200", async () => {
    const r = await call(undefined, "GET", "/organizer/schema");
    expect(r.status).toBe(200);
  });

  test("18: POST /digest/schema is not public -> 503 when unconfigured", async () => {
    const r = await call(undefined, "POST", "/digest/schema");
    expect(r.status).toBe(503);
  });

  test("19: POST /digest/schema with valid token -> 404", async () => {
    const r = await call(S, "POST", "/digest/schema", [["X-Pack-Token", S]]);
    expect(r.status).toBe(404);
  });

  test("20: trailing-slash alias does not bypass -> 401", async () => {
    const r = await call(S, "GET", "/digest/latest/");
    expect(r.status).toBe(401);
  });

  test("21: repeated-slash alias does not bypass -> 401", async () => {
    const r = await call(S, "GET", "//digest/latest");
    expect(r.status).toBe(401);
  });

  test("22: percent-encoded alias does not bypass -> 401", async () => {
    const r = await call(S, "GET", "/digest/%6c%61test");
    expect(r.status).toBe(401);
  });

  test("23: unknown route without token -> 401 (no route disclosure)", async () => {
    const r = await call(S, "GET", "/not-a-route");
    expect(r.status).toBe(401);
  });

  test("24: unknown route with valid token -> 404", async () => {
    const r = await call(S, "GET", "/not-a-route", [["X-Pack-Token", S]]);
    expect(r.status).toBe(404);
  });

  test("25: OPTIONS preflight stays public -> 204", async () => {
    const r = await call(undefined, "OPTIONS", "/digest/run");
    expect(r.status).toBe(204);
  });

  test("26: scheduled handler is not behind the HTTP gate", async () => {
    let submitted = 0;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        submitted++;
        p.catch(() => {});
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    await worker.scheduled({} as ScheduledEvent, stubEnv(undefined), ctx);
    expect(submitted).toBe(1);
  });

  test("27: 32 non-ASCII characters is a usable token", async () => {
    const t = "é".repeat(32);
    const r = await call(t, "GET", "/digest/latest", [["X-Pack-Token", t]]);
    expect(passedGate(r.status)).toBe(true);
  });

  // Not a Codex case: Codex audit of f2be157 (MEDIUM) required no JS-loop fallback.
  test("29: runtime without timingSafeEqual fails closed", async () => {
    const polyfill = subtle.timingSafeEqual;
    subtle.timingSafeEqual = nativeTimingSafeEqual;
    try {
      if (typeof subtle.timingSafeEqual === "function") return; // real Workers runtime
      expect(await tokenMatches(S, S)).toBe(false);
    } finally {
      subtle.timingSafeEqual = polyfill;
    }
  });

  test("28: oversized header never reaches a protected handler -> 401", async () => {
    const r = await call(S, "GET", "/digest/latest", [["X-Pack-Token", "0".repeat(16384)]]);
    expect(r.status).toBe(401);
  });
});
