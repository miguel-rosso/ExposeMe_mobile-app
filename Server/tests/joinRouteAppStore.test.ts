import { describe, expect, it, vi } from "vitest";

// EXP-420: with APP_STORE_ID set (read when the route module loads) the invite page links to the App Store on iPhones
// and desktops, never on Android. joinRoute.test.ts covers the page without an id.
const APP_STORE_ID = vi.hoisted(() => {
  process.env.APP_STORE_ID = "6739012345";
  return process.env.APP_STORE_ID;
});

import { useTestServer } from "./socketHarness";

const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.socketNull.ExposeMe";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const harness = useTestServer();

const joinPage = async (userAgent: string, acceptLanguage = "en") =>
  (await fetch(`${harness.url}/join/K7MQ4X`, { headers: { "user-agent": userAgent, "accept-language": acceptLanguage } })).text();

describe("GET /join/:code with APP_STORE_ID", () => {
  it("iPad/iPhone → App Store button only", async () => {
    const body = await joinPage(IPAD_UA, "es-ES");
    expect(body).toContain(`href="${APP_STORE_URL}"`);
    expect(body).toContain("Descárgalo en el App Store");
    expect(body).not.toContain("Pronto en el App Store");
    expect(body).not.toContain("play.google.com");
  });

  it("desktop → both store buttons", async () => {
    const body = await joinPage(DESKTOP_UA);
    expect(body).toContain(`href="${APP_STORE_URL}"`);
    expect(body).toContain("Download on the App Store");
    expect(body).toContain(`href="${PLAY_STORE_URL}"`);
  });

  it("Android → still Google Play only", async () => {
    const body = await joinPage(ANDROID_UA);
    expect(body).toContain(`href="${PLAY_STORE_URL}"`);
    expect(body).not.toContain("apps.apple.com");
  });
});
