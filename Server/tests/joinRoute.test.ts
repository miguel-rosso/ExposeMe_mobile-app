import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

// The App Store link is opt-in (APP_STORE_ID, read when the route module loads): off in this file, see
// joinRouteAppStore.test.ts for the page with an id
vi.hoisted(() => {
  delete process.env.APP_STORE_ID;
});

import { useTestServer } from "./socketHarness";

// /join/:code invite page: only well-formed room codes are accepted (EXP-198) and other input is never echoed back.
// The deep link uses the app's own scheme (EXP-168), the one the app registers in Client/app.json.
// EXP-420: Spanish or English from Accept-Language, and store links for people who don't have the app yet.

const APP_JSON = path.resolve(__dirname, "../../Client/app.json");
const appScheme: string = JSON.parse(fs.readFileSync(APP_JSON, "utf8")).expo.scheme;
const DEEP_LINK = "exposeme://screens/WaitingRoom?code=K7MQ4X";
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.socketNull.ExposeMe";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const harness = useTestServer();

async function joinPage(headers: Record<string, string> = {}) {
  const res = await fetch(`${harness.url}/join/K7MQ4X`, { headers });
  expect(res.status).toBe(200);
  return res.text();
}

describe("GET /join/:code", () => {
  it("deep links with the scheme the app registers", async () => {
    expect(appScheme).toBe("exposeme");
    const body = await (await fetch(`${harness.url}/join/K7MQ4X`)).text();
    expect(body).toContain(`${appScheme}://screens/WaitingRoom?code=K7MQ4X`);
    expect(body).not.toContain("myapp://");
  });

  it("valid code → 200 with code and deep link", async () => {
    const res = await fetch(`${harness.url}/join/K7MQ4X`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("K7MQ4X");
    expect(body).toContain(DEEP_LINK);
  });

  it("lowercase code → normalized to the canonical uppercase code", async () => {
    const res = await fetch(`${harness.url}/join/k7mq4x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(DEEP_LINK);
  });

  it("code with markup/quote characters → rejected and not reflected", async () => {
    const marker = `x"'<b>y</b>`;
    const res = await fetch(`${harness.url}/join/${encodeURIComponent(marker)}`);
    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.text();
    expect(body).not.toContain("<b>y</b>");
    expect(body).not.toContain(marker);
    expect(body).not.toContain("://screens/");
  });

  // The last three would turn into valid codes with String#toUpperCase ("ſ" → "S", "ß" → "SS", "ﬀ" → "FF")
  it.each(["K7MQ4", "K7MQ4XZ", "123456", "K7MQOX", "K7MQ-X", "Ｋ７ＭＱ４Ｘ", "K7MQ4ſ", "K7MQß", "K7MQﬀ"])("malformed code %s → rejected", async (code) => {
    const res = await fetch(`${harness.url}/join/${encodeURIComponent(code)}`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(code);
    expect(body).not.toContain("://screens/");
  });
});

describe("GET /join/:code language (EXP-420)", () => {
  it.each(["es-ES,es;q=0.9,en;q=0.8", "es", "es-419", "fr-FR,es;q=0.5", "en;q=0.5,es;q=0.6"])("prefers Spanish (%s) → Spanish page", async (acceptLanguage) => {
    const body = await joinPage({ "accept-language": acceptLanguage });
    expect(body).toContain('<html lang="es">');
    expect(body).toContain("¡Te han invitado a una partida!");
    expect(body).toContain("Abrir en la app");
    expect(body).not.toContain("Open in the app");
  });

  it.each(["en-US,en;q=0.9,es;q=0.8", "en", "fr-FR", ""])("doesn't prefer Spanish (%j) → English page", async (acceptLanguage) => {
    const body = await joinPage(acceptLanguage ? { "accept-language": acceptLanguage } : {});
    expect(body).toContain('<html lang="en">');
    expect(body).toContain("You've been invited to a game!");
    expect(body).toContain("Open in the app");
    expect(body).not.toContain("Abrir en la app");
  });

  it("varies on Accept-Language and User-Agent (the page depends on both)", async () => {
    const vary = (await fetch(`${harness.url}/join/K7MQ4X`)).headers.get("vary") ?? "";
    expect(vary).toMatch(/Accept-Language/i);
    expect(vary).toMatch(/User-Agent/i);
  });
});

describe("GET /join/:code store links (EXP-420)", () => {
  it("Android → Google Play button, nothing about the App Store", async () => {
    const body = await joinPage({ "user-agent": ANDROID_UA, "accept-language": "es" });
    expect(body).toContain(`href="${PLAY_STORE_URL}"`);
    expect(body).toContain("Disponible en Google Play");
    expect(body).not.toContain("App Store");
  });

  it("iPhone without APP_STORE_ID → no store link, a neutral coming-soon note", async () => {
    const body = await joinPage({ "user-agent": IPHONE_UA, "accept-language": "en" });
    expect(body).not.toContain("apps.apple.com");
    expect(body).not.toContain("play.google.com");
    expect(body).toContain("Coming soon to the App Store");
  });

  it("iPhone in Spanish → Spanish coming-soon note", async () => {
    expect(await joinPage({ "user-agent": IPHONE_UA, "accept-language": "es" })).toContain("Pronto en el App Store");
  });

  it("desktop (or no user agent) → Google Play and the App Store note", async () => {
    for (const headers of [{ "user-agent": DESKTOP_UA }, {}] as Record<string, string>[]) {
      const body = await joinPage(headers);
      expect(body).toContain(`href="${PLAY_STORE_URL}"`);
      expect(body).toContain("Coming soon to the App Store");
      expect(body).not.toContain("apps.apple.com");
    }
  });

  it("keeps the nonce CSP: one inline script, carrying the header's nonce", async () => {
    const res = await fetch(`${harness.url}/join/K7MQ4X`, { headers: { "user-agent": ANDROID_UA } });
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonce).toBeTruthy();
    const body = await res.text();
    expect(body.match(/<script/g)).toHaveLength(1);
    expect(body).toContain(`<script nonce="${nonce}">`);
  });
});
