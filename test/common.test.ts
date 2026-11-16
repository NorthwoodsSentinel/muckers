/**
 * common.test.ts — the shared response helpers and the PACK_TOKEN predicates in src/common.ts.
 *
 * Why: every route answers through these helpers, so their status codes, bodies and CORS headers are the
 * worker's public contract. The adversarial gate cases live in gate.test.ts; this file pins the helpers.
 */
import { timingSafeEqual } from "node:crypto";
import { describe, expect, test } from "vitest";
import { corsHeaders, json, notConfigured, notFound, packTokenUsable, tokenMatches, unauthorized } from "../src/common";

const subtle = crypto.subtle as unknown as {
  timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean;
};

describe("response helpers", () => {
  test("corsHeaders allows any origin, the three methods and the token header", () => {
    const h = corsHeaders();
    expect(h.get("Access-Control-Allow-Origin")).toBe("*");
    expect(h.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(h.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Pack-Token");
  });

  test("json defaults to 200, pretty-prints, and carries CORS + content type", async () => {
    const r = json({ a: 1 });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("application/json");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await r.text()).toBe('{\n  "a": 1\n}');
  });

  test("json honors an explicit status", () => {
    expect(json({}, 418).status).toBe(418);
  });

  test("unauthorized, notFound and notConfigured", async () => {
    const u = unauthorized();
    expect(u.status).toBe(401);
    expect(await u.json()).toEqual({ error: "unauthorized", message: "set X-Pack-Token header" });
    const n = notFound("/x");
    expect(n.status).toBe(404);
    expect(await n.json()).toEqual({ error: "not_found", path: "/x" });
    const c = notConfigured();
    expect(c.status).toBe(503);
    expect(await c.json()).toEqual({ error: "not_configured", message: "set PACK_TOKEN with wrangler secret put" });
  });
});

describe("packTokenUsable", () => {
  test.each([
    [undefined, false],
    ["", false],
    ["a".repeat(31), false],
    ["a".repeat(32), true],
    ["CHANGE-ME" + "a".repeat(40), false],
  ])("%j -> %s", (value, expected) => {
    expect(packTokenUsable(value)).toBe(expected);
  });
});

describe("tokenMatches", () => {
  test("equal and unequal tokens under a runtime that has timingSafeEqual", async () => {
    const before = subtle.timingSafeEqual;
    subtle.timingSafeEqual = (a, b) => timingSafeEqual(a, b);
    try {
      expect(await tokenMatches("x".repeat(32), "x".repeat(32))).toBe(true);
      expect(await tokenMatches("x".repeat(32), "y".repeat(32))).toBe(false);
      expect(await tokenMatches("short", "x".repeat(32))).toBe(false);
    } finally {
      subtle.timingSafeEqual = before;
    }
  });
});
