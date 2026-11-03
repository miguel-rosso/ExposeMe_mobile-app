import { describe, expect, it, vi } from "vitest";

// CONTACT_EMAIL and CONTROLLER_NAME are read when the route module loads: set before the app is imported
const CONTACT_EMAIL = vi.hoisted(() => {
  process.env.CONTACT_EMAIL = "privacy+a&b@example.com";
  process.env.CONTROLLER_NAME = "socketNull";
  return process.env.CONTACT_EMAIL;
});

import { useTestServer } from "./socketHarness";
import { STATIC_PAGE_CSP } from "../middlewares/securityHeaders";

// EXP-427: GET /privacy serves the policy in Spanish or English, with a script-free CSP, cache headers and the
// configured contact address. privacyPage.test.ts covers the text itself.

const harness = useTestServer();

const privacy = (query = "", acceptLanguage?: string) =>
  fetch(`${harness.url}/privacy${query}`, { headers: acceptLanguage ? { "accept-language": acceptLanguage } : {} });

describe("GET /privacy", () => {
  it("serves HTML with a script-free CSP, cache headers and Vary: Accept-Language", async () => {
    const res = await privacy();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toBe(STATIC_PAGE_CSP);
    expect(STATIC_PAGE_CSP).toContain("default-src 'none'");
    expect(STATIC_PAGE_CSP).not.toContain("script-src");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("vary")).toMatch(/Accept-Language/i);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("Accept-Language es → Spanish, en or none → English", async () => {
    expect(await (await privacy("", "es-ES,es;q=0.9")).text()).toContain("Política de privacidad de ExposeMe");
    expect(await (await privacy("", "en-GB")).text()).toContain("ExposeMe privacy policy");
    expect(await (await privacy()).text()).toContain("ExposeMe privacy policy");
  });

  it("?lang overrides Accept-Language; an unknown value is ignored", async () => {
    expect(await (await privacy("?lang=en", "es")).text()).toContain("ExposeMe privacy policy");
    expect(await (await privacy("?lang=es", "en")).text()).toContain("Política de privacidad de ExposeMe");
    expect(await (await privacy("?lang=fr", "es")).text()).toContain("Política de privacidad de ExposeMe");
  });

  it("shows CONTACT_EMAIL (HTML-escaped) and CONTROLLER_NAME", async () => {
    const body = await (await privacy("?lang=en")).text();
    expect(CONTACT_EMAIL).toContain("&");
    expect(body).toContain(`<a href="mailto:privacy+a&amp;b@example.com">privacy+a&amp;b@example.com</a>`);
    expect(body).toContain("socketNull publishes ExposeMe");
  });
});
