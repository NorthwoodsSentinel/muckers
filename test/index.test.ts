/**
 * index.test.ts — routing and the service-info page in src/index.ts.
 *
 * Why: gate.test.ts proves who gets past the token check; this file proves where an authorized request goes
 * (each route reaches its handler), what GET / reports, and that a handler that throws becomes a 500.
 */
import { timingSafeEqual } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import worker from "../src/index";
import { fakeEnv, type SqlHandler } from "./helpers/fakes";

const subtle = crypto.subtle as unknown as {
  timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean;
};
beforeAll(() => {
  subtle.timingSafeEqual = (a, b) => timingSafeEqual(a, b);
});

const TOKEN = "0123456789abcdef0123456789abcdef";

function call(method: string, path: string, handler?: SqlHandler, body?: string) {
  const { env, calls } = fakeEnv({}, handler);
  const req = new Request(`https://muckers.test${path}`, { method, headers: { "X-Pack-Token": TOKEN }, body });
  return { res: worker.fetch(req, env), calls };
}

describe("GET /", () => {
  test("reports completed digests and rule-of-three proposals from D1", async () => {
    const { res, calls } = call("GET", "/", ({ sql }) => (sql.includes("digest_runs") ? { n: 4 } : { n: 2 }));
    const body = (await (await res).json()) as {
      service: string;
      modules: { digest: { completed_runs: number }; organizer: { open_proposals_at_rule_of_three: number } };
    };
    expect(body.service).toBe("muckers");
    expect(body.modules.digest.completed_runs).toBe(4);
    expect(body.modules.organizer.open_proposals_at_rule_of_three).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test("counts are 0 when D1 returns no row", async () => {
    const body = (await (await call("GET", "/").res).json()) as {
      modules: { digest: { completed_runs: number }; organizer: { open_proposals_at_rule_of_three: number } };
    };
    expect(body.modules.digest.completed_runs).toBe(0);
    expect(body.modules.organizer.open_proposals_at_rule_of_three).toBe(0);
  });

  test("still answers 200 when D1 is not migrated (query throws)", async () => {
    const res = await call("GET", "/", () => {
      throw new Error("no such table");
    }).res;
    expect(res.status).toBe(200);
  });
});

describe("authorized routing", () => {
  test("GET /digest/latest reaches its handler", async () => {
    expect((await call("GET", "/digest/latest").res).status).toBe(404);
  });

  test("GET /digest/list reaches its handler", async () => {
    const res = await call("GET", "/digest/list").res;
    expect(await res.json()).toEqual({ ok: true, runs: [] });
  });

  test("POST /digest/run reaches its handler", async () => {
    expect((await call("POST", "/digest/run", undefined, "{}").res).status).toBe(400);
  });

  test("POST /organizer/scan reaches its handler", async () => {
    expect((await call("POST", "/organizer/scan").res).status).toBe(400);
  });

  test("GET /organizer/proposals reaches its handler", async () => {
    const body = (await (await call("GET", "/organizer/proposals").res).json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("POST /organizer/proposals/:id/:action passes the id and action", async () => {
    const { res, calls } = call("POST", "/organizer/proposals/ab12-cd/dismiss");
    expect(await (await res).json()).toEqual({ ok: true, proposal_id: "ab12-cd", action: "dismiss" });
    expect(calls[0]?.sql).toContain("status = 'dismissed'");
  });

  test("an action on a non-hex id is not routed -> 404", async () => {
    expect((await call("POST", "/organizer/proposals/XYZ/dismiss").res).status).toBe(404);
  });

  test("GET on an action path is not routed -> 404", async () => {
    expect((await call("GET", "/organizer/proposals/ab12/dismiss").res).status).toBe(404);
  });

  test("a handler that throws becomes 500 internal_error", async () => {
    const res = await call("GET", "/digest/list", () => {
      throw new Error("d1 down");
    }).res;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error", detail: "Error: d1 down" });
  });
});
