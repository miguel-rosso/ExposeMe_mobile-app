import fs from "fs";
import { AddressInfo } from "net";
import type { Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io, server } from "../app";
import { errorHandler } from "../middlewares/errorHandler";

// HTTP hardening: security headers on every response, JSON 404 for unknown routes, strict status handling
// in the final error handler.

const UPLOAD_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const dir = `${tmp}/exposeme-http-hardening-test-${process.pid}-${Date.now()}`;
  process.env.UPLOAD_DIR = dir;
  return dir;
});

let url: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

// ── Security headers ──
describe("security headers", () => {
  const expectBaseHeaders = (res: Response | globalThis.Response) => {
    const h = (res as globalThis.Response).headers;
    expect(h.get("x-powered-by")).toBeNull();
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("referrer-policy")).toBe("no-referrer");
    expect(h.get("cross-origin-resource-policy")).toBe("same-site");
    expect(h.get("strict-transport-security")).toMatch(/max-age=\d+/);
    const csp = h.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    return csp;
  };

  it.each(["/", "/health", "/nope", "/temp/whatever"])("%s carries the API headers with a deny-all CSP", async (p) => {
    const res = await fetch(`${url}${p}`);
    const csp = expectBaseHeaders(res);
    expect(csp).not.toMatch(/script-src|style-src/);
  });

  it("errors from the final handler carry them too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(`${url}/temp/%`);
    expect(res.status).toBe(400);
    expectBaseHeaders(res);
    vi.restoreAllMocks();
  });

  it("the /join invite page only allows its own inline script (per-response nonce) and inline style", async () => {
    const res1 = await fetch(`${url}/join/K7MQ4X`);
    const res2 = await fetch(`${url}/join/K7MQ4X`);
    expect(res1.status).toBe(200);
    const csp = expectBaseHeaders(res1);
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    const html = await res1.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect((html.match(/<script/g) ?? []).length).toBe(1);
    const nonce2 = /'nonce-([^']+)'/.exec(res2.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonce2).toBeTruthy();
    expect(nonce2).not.toBe(nonce);
  });
});

// ── JSON 404 ──
describe("unknown routes", () => {
  it.each([
    ["GET", "/zz-probe-path-1234"],
    ["POST", "/zz-probe-path-1234"],
    ["GET", "/zz-probe-path-1234/%3Cscript%3E"],
    ["DELETE", "/upload"],
  ])("%s %s → 404 JSON {error:'Not found'} without echoing the path", async (method, p) => {
    const res = await fetch(`${url}${p}`, { method });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Not found" });
    expect(text).not.toMatch(/zz-probe|script|Cannot|<html/i);
  });
});

// ── errorHandler status validation ──
describe("errorHandler status", () => {
  const run = (err: unknown) => {
    const res = { headersSent: false, statusCode: 0, body: undefined as unknown } as unknown as Response & { body: unknown };
    (res as unknown as { status: (s: number) => unknown }).status = vi.fn((s: number) => {
      res.statusCode = s;
      return res;
    });
    (res as unknown as { json: (b: unknown) => unknown }).json = vi.fn((b: unknown) => {
      res.body = b;
      return res;
    });
    const req = { method: "GET", path: "/x" } as Request;
    vi.spyOn(console, "error").mockImplementation(() => {});
    errorHandler(err, req, res, vi.fn());
    vi.restoreAllMocks();
    return res;
  };

  it.each([400, 404, 413, 499])("keeps integer 4xx status %s", (status) => {
    expect(run({ status }).statusCode).toBe(status);
    expect(run({ statusCode: status }).statusCode).toBe(status);
  });

  it.each([404.5, 400.0001, 499.9, NaN, Infinity, "404", 200, 399, 500, 503, null, undefined])(
    "turns invalid/non-4xx status %s into 500",
    (status) => {
      const res = run({ status });
      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ error: "Internal server error" });
    },
  );

  it("handles non-object errors", () => {
    expect(run(null).statusCode).toBe(500);
    expect(run("boom").statusCode).toBe(500);
  });
});
