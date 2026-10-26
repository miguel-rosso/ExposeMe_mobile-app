import fs from "fs";
import path from "path";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, server } from "../app";

// /join/:code invite page: only well-formed room codes are accepted (EXP-198) and other input is never echoed back.
// The deep link uses the app's own scheme (EXP-168), the one the app registers in Client/app.json.

const APP_JSON = path.resolve(__dirname, "../../Client/app.json");
const appScheme: string = JSON.parse(fs.readFileSync(APP_JSON, "utf8")).expo.scheme;
const DEEP_LINK = "exposeme://screens/WaitingRoom?code=K7MQ4X";

let url: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

describe("GET /join/:code", () => {
  it("deep links with the scheme the app registers", async () => {
    expect(appScheme).toBe("exposeme");
    const body = await (await fetch(`${url}/join/K7MQ4X`)).text();
    expect(body).toContain(`${appScheme}://screens/WaitingRoom?code=K7MQ4X`);
    expect(body).not.toContain("myapp://");
  });

  it("valid code → 200 with code and deep link", async () => {
    const res = await fetch(`${url}/join/K7MQ4X`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("K7MQ4X");
    expect(body).toContain(DEEP_LINK);
  });

  it("lowercase code → normalized to the canonical uppercase code", async () => {
    const res = await fetch(`${url}/join/k7mq4x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(DEEP_LINK);
  });

  it("code with markup/quote characters → rejected and not reflected", async () => {
    const marker = `x"'<b>y</b>`;
    const res = await fetch(`${url}/join/${encodeURIComponent(marker)}`);
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.text();
    expect(body).not.toContain("<b>y</b>");
    expect(body).not.toContain(marker);
    expect(body).not.toContain("://screens/");
  });

  // The last three would turn into valid codes with String#toUpperCase ("ſ" → "S", "ß" → "SS", "ﬀ" → "FF")
  it.each(["K7MQ4", "K7MQ4XZ", "123456", "K7MQOX", "K7MQ-X", "Ｋ７ＭＱ４Ｘ", "K7MQ4ſ", "K7MQß", "K7MQﬀ"])("malformed code %s → rejected", async (code) => {
    const res = await fetch(`${url}/join/${encodeURIComponent(code)}`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(code);
    expect(body).not.toContain("://screens/");
  });
});
