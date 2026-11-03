import { describe, expect, it, vi } from "vitest";
import { UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import {
  parseContactEmail,
  parseControllerName,
  pickPrivacyLanguage,
  PRIVACY_LAST_UPDATED,
  renderPrivacyPage,
} from "../routes/privacyPage";

// EXP-427: the privacy policy both stores require, in Spanish and English. These cover the rendered text and its
// configuration; privacyRoute.test.ts covers the served page (headers, language negotiation, CONTACT_EMAIL).

const render = (language: "en" | "es", contactEmail: string | null = null, controllerName: string | null = null) =>
  renderPrivacyPage({ language, contactEmail, controllerName });

describe("renderPrivacyPage", () => {
  it("English: states the key facts", () => {
    const page = render("en");
    expect(page).toContain('<html lang="en">');
    expect(page).toContain("ExposeMe privacy policy");
    expect(UPLOAD_TTL_MS).toBe(30 * 60_000);
    expect(page).toContain("within 30 minutes");
    expect(page).toContain("no accounts, no ads and no analytics or tracking");
    expect(page).toContain("not directed at children under 13");
    expect(page).toContain("not stored by the server");
    expect(page).toContain("Chat messages are only relayed, never kept.");
    expect(page).toContain("doesn't write it to its logs");
    expect(page).toContain("the one on screen at that moment once its round ends");
    expect(page).toContain("GDPR art. 6(1)(b)");
    expect(page).toContain("(art. 6(1)(f))");
    expect(page).toContain("Render Services, Inc. (United States)");
    // Reporting doesn't exist yet (EXP-423 adds its paragraph when it ships)
    expect(page).not.toMatch(/report a photo|days so that it can be reviewed/);
  });

  it("Spanish: the same facts in Spanish", () => {
    const page = render("es");
    expect(page).toContain('<html lang="es">');
    expect(page).toContain("Política de privacidad de ExposeMe");
    expect(page).toContain("como máximo 30 minutos");
    expect(page).toContain("No hay cuentas, ni anuncios, ni analítica ni seguimiento");
    expect(page).toContain("no está dirigida a menores de 13 años");
    expect(page).toContain("Los mensajes del chat solo se reenvían, nunca se guardan.");
    expect(page).toContain("la que está en pantalla en ese momento, al acabar su ronda");
    expect(page).toContain("art. 6.1.b del RGPD");
    expect(page).toContain("(art. 6.1.f)");
    expect(page).toContain("Render Services, Inc. (Estados Unidos)");
    expect(page).not.toMatch(/denuncia/i);
    expect(page).not.toContain("privacy policy");
  });

  it("shows the last-updated date in the page language", () => {
    expect(render("en")).toContain(`<time datetime="${PRIVACY_LAST_UPDATED}">November 3, 2026</time>`);
    expect(render("es")).toContain(`<time datetime="${PRIVACY_LAST_UPDATED}">3 de noviembre de 2026</time>`);
  });

  it("without a contact address → a neutral pointer to the store page, no mailto", () => {
    expect(render("en")).toContain("use the developer contact shown on the app's store page");
    expect(render("es")).toContain("usa el contacto del desarrollador que aparece en la ficha de la app");
    expect(render("en")).not.toContain("mailto:");
  });

  it("with a contact address → a mailto link, HTML-escaped", () => {
    const page = render("en", `"<b>x</b>"&y@example.com`);
    expect(page).toContain(
      `<a href="mailto:&quot;&lt;b&gt;x&lt;/b&gt;&quot;&amp;y@example.com">&quot;&lt;b&gt;x&lt;/b&gt;&quot;&amp;y@example.com</a>`,
    );
    expect(page).not.toContain("<b>x</b>");
    expect(page).not.toContain("use the developer contact shown on the app's store page");
  });

  it("without a publisher name → points to the developer on the store page", () => {
    expect(render("en")).toContain("ExposeMe's publisher, the developer shown on the app's store page, is responsible");
    expect(render("es")).toContain("El editor de ExposeMe, el desarrollador que aparece en la ficha de la app en la tienda");
    expect(render("en")).not.toContain("publishes ExposeMe");
  });

  it("names the publisher, HTML-escaped", () => {
    expect(render("en", null, "socketNull")).toContain("socketNull publishes ExposeMe");
    const page = render("es", null, `Ana <img src=x> & Co`);
    expect(page).toContain("Ana &lt;img src=x&gt; &amp; Co publica ExposeMe");
    expect(page).not.toContain("<img");
  });

  it("is script-free", () => {
    expect(render("en", "privacy@example.com")).not.toMatch(/<script/i);
  });
});

describe("pickPrivacyLanguage", () => {
  it("?lang=es|en wins over Accept-Language", () => {
    expect(pickPrivacyLanguage("es", "en")).toBe("es");
    expect(pickPrivacyLanguage("en", "es")).toBe("en");
  });

  it("unknown, missing or repeated ?lang → Accept-Language, then English", () => {
    expect(pickPrivacyLanguage("fr", "es")).toBe("es");
    expect(pickPrivacyLanguage(undefined, "es")).toBe("es");
    expect(pickPrivacyLanguage(["es", "en"], "en")).toBe("en");
    expect(pickPrivacyLanguage(undefined, false)).toBe("en");
  });
});

describe("parseContactEmail", () => {
  it("unset or blank → null", () => {
    expect(parseContactEmail(undefined)).toBeNull();
    expect(parseContactEmail("  ")).toBeNull();
  });

  it("an address → trimmed", () => {
    expect(parseContactEmail(" privacy@example.com ")).toBe("privacy@example.com");
  });

  it("not an address → null, logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseContactEmail("privacy at example")).toBeNull();
    expect(parseContactEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("parseControllerName", () => {
  it("a name → trimmed, no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseControllerName(" socketNull ", true)).toBe("socketNull");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("unset or blank → null, logged only in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseControllerName(undefined, false)).toBeNull();
    expect(parseControllerName("  ", false)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(parseControllerName(undefined, true)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[config\] CONTROLLER_NAME is unset/);
    warn.mockRestore();
  });
});
