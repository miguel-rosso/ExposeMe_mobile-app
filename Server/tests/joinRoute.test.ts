import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, server } from "../app";

// /join/:code invite page: only well-formed room codes are accepted (EXP-198) and other input is never echoed back.

let url: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

describe("GET /join/:code", () => {
  it("valid code → 200 with code and deep link", async () => {
    const res = await fetch(`${url}/join/K7MQ4X`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("K7MQ4X");
    expect(body).toContain("myapp://screens/WaitingRoom?code=K7MQ4X");
  });

  it("lowercase code → normalized to the canonical uppercase code", async () => {
    const res = await fetch(`${url}/join/k7mq4x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("myapp://screens/WaitingRoom?code=K7MQ4X");
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

  // The last three would turn into valid codes with String#toUpperCase ("ſ" → "S", "ß" → "SS", "ﬀ" → "FF")
  it.each(["K7MQ4", "K7MQ4XZ", "123456", "K7MQOX", "K7MQ-X", "Ｋ７ＭＱ４Ｘ", "K7MQ4ſ", "K7MQß", "K7MQﬀ"])("malformed code %s → rejected", async (code) => {
    const res = await fetch(`${url}/join/${encodeURIComponent(code)}`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(code);
    expect(body).not.toContain("myapp://");
  });
});
