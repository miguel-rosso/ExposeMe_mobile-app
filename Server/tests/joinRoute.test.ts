import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, server } from "../app";

// /join/:code invite page: only 6-digit codes are accepted and input is never echoed back.

let url: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

describe("GET /join/:code", () => {
  it("valid 6-digit code → 200 with code and deep link", async () => {
    const res = await fetch(`${url}/join/123456`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("123456");
    expect(body).toContain("myapp://screens/WaitingRoom?code=123456");
  });

  it("code with markup/quote characters → rejected and not reflected", async () => {
    const marker = `x"'<b>y</b>`;
    const res = await fetch(`${url}/join/${encodeURIComponent(marker)}`);
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.text();
    expect(body).not.toContain("<b>y</b>");
    expect(body).not.toContain(marker);
    expect(body).not.toContain("myapp://");
  });

  it.each(["12345", "1234567", "abcdef", "12345a"])("malformed code %s → rejected", async (code) => {
    const res = await fetch(`${url}/join/${code}`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(code);
    expect(body).not.toContain("myapp://");
  });
});
