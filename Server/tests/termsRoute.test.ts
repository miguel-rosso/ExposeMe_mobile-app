import { describe, expect, it, vi } from "vitest";

// CONTACT_EMAIL is read when the route modules load: set before the app is imported
vi.hoisted(() => {
  process.env.CONTACT_EMAIL = "terms@example.com";
});

import { useTestServer } from "./socketHarness";
import { STATIC_PAGE_CSP } from "../middlewares/securityHeaders";

// EXP-433: GET /terms serves the terms of use exactly like /privacy serves the policy: Spanish or English, a
// script-free CSP, cache headers and the configured contact address. termsPage.test.ts covers the text itself.

const harness = useTestServer();

const terms = (query = "", acceptLanguage?: string) =>
  fetch(`${harness.url}/terms${query}`, { headers: acceptLanguage ? { "accept-language": acceptLanguage } : {} });

describe("GET /terms", () => {
  it("serves HTML with a script-free CSP, cache headers and Vary: Accept-Language", async () => {
    const res = await terms();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toBe(STATIC_PAGE_CSP);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("vary")).toMatch(/Accept-Language/i);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("Accept-Language es → Spanish, en or none → English", async () => {
    expect(await (await terms("", "es-ES,es;q=0.9")).text()).toContain("Condiciones de uso de ExposeMe");
    expect(await (await terms("", "en-GB")).text()).toContain("ExposeMe terms of use");
    expect(await (await terms()).text()).toContain("ExposeMe terms of use");
  });

  it("?lang overrides Accept-Language; an unknown value is ignored", async () => {
    expect(await (await terms("?lang=en", "es")).text()).toContain("ExposeMe terms of use");
    expect(await (await terms("?lang=es", "en")).text()).toContain("Condiciones de uso de ExposeMe");
    expect(await (await terms("?lang=fr", "es")).text()).toContain("Condiciones de uso de ExposeMe");
  });

  it("shows CONTACT_EMAIL", async () => {
    const body = await (await terms("?lang=en")).text();
    expect(body).toContain(`<a href="mailto:terms@example.com">terms@example.com</a>`);
  });
});
