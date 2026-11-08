import { describe, expect, it, vi } from "vitest";
import { UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import { pickLegalPageLanguage } from "../routes/legalPage";
import { parseContactEmail, parseControllerName, PRIVACY_LAST_UPDATED, renderPrivacyPage } from "../routes/privacyPage";

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
    expect(page).toContain("The server doesn't store them");
    expect(page).toContain("doesn't write it to its logs");
    expect(page).toContain("the one on screen at that moment once its round ends");
    expect(page).toContain("GDPR art. 6(1)(b)");
    expect(page).toContain("(art. 6(1)(f))");
    expect(page).toContain("Render Services, Inc. (United States)");
  });

  it("Spanish: the same facts in Spanish", () => {
    const page = render("es");
    expect(page).toContain('<html lang="es">');
    expect(page).toContain("Política de privacidad de ExposeMe");
    expect(page).toContain("como máximo 30 minutos");
    expect(page).toContain("No hay cuentas, ni anuncios, ni analítica ni seguimiento");
    expect(page).toContain("no está dirigida a menores de 13 años");
    expect(page).toContain("El servidor no los guarda");
    expect(page).toContain("la que está en pantalla en ese momento, al acabar su ronda");
    expect(page).toContain("art. 6.1.b del RGPD");
    expect(page).toContain("(art. 6.1.f)");
    expect(page).toContain("Render Services, Inc. (Estados Unidos)");
    expect(page).not.toContain("privacy policy");
  });

  // EXP-423: reports keep the reported photo and message beyond the game, for the retention period
  describe("reports", () => {
    const reportsSection = (page: string, heading: string) => page.split(`<h2>${heading}</h2>`)[1].split("<h2>")[0];

    it("English: what a report stores, who sees it and for how long", () => {
      const page = render("en");
      const section = reportsSection(page, "Reports");
      for (const item of [
        "the room code", "the round", "your player name", "the reported player's name", "the reason you picked",
        "the text of a reported message", "a copy of a reported photo",
      ]) expect(section).toContain(item);
      expect(section).toContain("Only we, the operator, review reports");
      expect(section).toContain("deleted 90 days after the report");
      expect(section).not.toContain("notification service");
      // The other sections stay true: a reported photo outlives the 30 minutes, and we see reported content
      expect(page).toContain("unless one is reported");
      expect(page).toContain("If someone reports your photo or your message, we see it too");
      expect(page).toContain("A reported photo is copied and kept with its report.");
      expect(page).toContain("<strong>Reports</strong>: 90 days");
      expect(page).toContain("never photos, messages or IP addresses (reports are never written to them)");
      expect(page).toContain("Nobody else gets it");
      expect(page).toContain("the abuse limits, the reports and the server logs");
    });

    it("Spanish: the same in Spanish", () => {
      const page = render("es");
      const section = reportsSection(page, "Denuncias");
      for (const item of [
        "el código de la sala", "la ronda", "tu nombre de jugador", "el nombre del jugador denunciado",
        "el motivo que elegiste", "el texto del mensaje denunciado", "una copia de la foto denunciada",
      ]) expect(section).toContain(item);
      expect(section).toContain("Solo nosotros, como responsables del servicio, revisamos las denuncias");
      expect(section).toContain("se borran 90 días después de la denuncia");
      expect(page).toContain("salvo que se denuncie alguna");
      expect(page).toContain("Si alguien denuncia tu foto o tu mensaje, también lo vemos nosotros");
      expect(page).toContain("De una foto denunciada se guarda una copia con su denuncia.");
      expect(page).toContain("<strong>Denuncias</strong>: 90 días");
      expect(page).toContain("nunca fotos, mensajes ni direcciones IP (las denuncias nunca se anotan en ellos)");
      expect(page).toContain("Nadie más los recibe");
    });

    it("names the webhook's provider as a recipient only when one is configured", () => {
      const withWebhook = (language: "en" | "es") =>
        renderPrivacyPage({ language, contactEmail: null, controllerName: null, reportWebhook: true });
      expect(reportsSection(withWebhook("en"), "Reports")).toContain("also sent to the notification service we use");
      expect(reportsSection(withWebhook("es"), "Denuncias")).toContain("se envía además al servicio de avisos que usamos");
      expect(reportsSection(render("es"), "Denuncias")).not.toContain("servicio de avisos");
      // «Who sees it» names it too, instead of saying nobody else gets the data
      expect(reportsSection(withWebhook("en"), "Who sees it")).toContain("Apart from the summaries of reports sent to our notification service");
      expect(reportsSection(withWebhook("en"), "Who sees it")).not.toContain("Nobody else gets it");
      expect(reportsSection(withWebhook("es"), "Quién lo ve")).toContain("Aparte de los resúmenes de denuncias que se envían a nuestro servicio de avisos");
    });

    it("states the configured retention", () => {
      const page = renderPrivacyPage({ language: "en", contactEmail: null, controllerName: null, reportRetentionDays: 30 });
      expect(page).toContain("deleted 30 days after the report");
      expect(page).toContain("<strong>Reports</strong>: 30 days");
    });
  });

  // EXP-433: Android 14+ also offers partial access («Select photos»), not only iPhone
  it("says a selection of photos can be allowed on iPhone and on Android 14 or later", () => {
    expect(render("en")).toContain(
      'On iPhone, and on Android 14 or later, you can allow only a selection of photos ("Limited Access" or "Select photos")',
    );
    expect(render("es")).toContain(
      "En iPhone, y en Android 14 o posterior, puedes permitir solo una selección de fotos («Acceso limitado» o «Seleccionar fotos»)",
    );
  });

  // EXP-433: the phone also keeps which version of the terms of use was accepted
  it("lists the accepted terms version among what stays on the phone", () => {
    expect(render("en")).toContain(
      "the app saves your name, your language, a code to rejoin your last game and which version of the terms you accepted.",
    );
    expect(render("es")).toContain(
      "la app guarda tu nombre, tu idioma, un código para volver a tu última partida y qué versión de las condiciones aceptaste.",
    );
  });

  it("shows the last-updated date in the page language", () => {
    expect(render("en")).toContain(`<time datetime="${PRIVACY_LAST_UPDATED}">November 8, 2026</time>`);
    expect(render("es")).toContain(`<time datetime="${PRIVACY_LAST_UPDATED}">8 de noviembre de 2026</time>`);
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

describe("pickLegalPageLanguage", () => {
  it("?lang=es|en wins over Accept-Language", () => {
    expect(pickLegalPageLanguage("es", "en")).toBe("es");
    expect(pickLegalPageLanguage("en", "es")).toBe("en");
  });

  it("unknown, missing or repeated ?lang → Accept-Language, then English", () => {
    expect(pickLegalPageLanguage("fr", "es")).toBe("es");
    expect(pickLegalPageLanguage(undefined, "es")).toBe("es");
    expect(pickLegalPageLanguage(["es", "en"], "en")).toBe("en");
    expect(pickLegalPageLanguage(undefined, false)).toBe("en");
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
