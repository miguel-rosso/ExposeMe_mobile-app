import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { renderTermsPage, TERMS_LAST_UPDATED } from "../routes/termsPage";

// EXP-433 (DEC-058): the terms of use players accept on the app's first screen, in Spanish and English: the content
// that is not allowed in photos, chat and names, the consequences and a contact. termsRoute.test.ts covers the served
// page.

const render = (language: "en" | "es", contactEmail: string | null = null) => renderTermsPage({ language, contactEmail });
const section = (page: string, heading: string) => page.split(`<h2>${heading}</h2>`)[1].split("<h2>")[0];

// The app asks every device to accept the terms again when its TERMS_VERSION changes: it must move with the page's date,
// or changed terms would never be asked for (or unchanged ones asked for again)
describe("terms version", () => {
  const CLIENT_TERMS_FILE = path.resolve(__dirname, "../../Client/src/utils/termsAcceptance.ts");

  it("the app's TERMS_VERSION is the page's TERMS_LAST_UPDATED", () => {
    const source = fs.readFileSync(CLIENT_TERMS_FILE, "utf8");
    const clientVersion = source.match(/export const TERMS_VERSION = "([^"]+)";/)?.[1];
    expect(clientVersion).toBe(TERMS_LAST_UPDATED);
  });
});

describe("renderTermsPage", () => {
  it("English: what is not allowed in photos, chat messages and player names", () => {
    const page = render("en");
    expect(page).toContain('<html lang="en">');
    expect(page).toContain("<h1>ExposeMe terms of use</h1>");
    expect(page).toContain("By using ExposeMe you accept these terms.");
    const prohibited = section(page, "What is not allowed");
    expect(prohibited).toContain("In photos, chat messages and player names, don't share:");
    for (const item of [
      "Nudity or sexual content",
      "Anything involving minors",
      "Harassment or bullying",
      "Hate",
      "Violence",
      "Photos of other people without their permission",
    ]) expect(prohibited).toContain(`<strong>${item}`);
  });

  it("Spanish: the same in Spanish", () => {
    const page = render("es");
    expect(page).toContain('<html lang="es">');
    expect(page).toContain("<h1>Condiciones de uso de ExposeMe</h1>");
    expect(page).toContain("Al usar ExposeMe aceptas estas condiciones.");
    const prohibited = section(page, "Qué no está permitido");
    expect(prohibited).toContain("En fotos, mensajes de chat y nombres de jugador, no compartas:");
    for (const item of [
      "Desnudos ni contenido sexual",
      "Nada con menores",
      "Acoso",
      "Odio",
      "Violencia",
      "Fotos de otras personas sin su permiso",
    ]) expect(prohibited).toContain(`<strong>${item}`);
    expect(page).not.toContain("terms of use");
  });

  it("states the consequences: report, mute and kick, and reported illegal content", () => {
    const en = section(render("en"), "What happens if someone breaks these terms");
    expect(en).toContain(
      "Any player can report a photo or a chat message, and mute a player to stop seeing their chat messages and emoji reactions.",
    );
    expect(en).toContain("The host can kick a player out of the room.");
    expect(en).toContain("We review reports.");
    // A possibility, not a commitment (pending the owner's wording)
    expect(en).toContain("Illegal content, such as child sexual abuse material, may be reported to the authorities.");
    const es = section(render("es"), "Qué pasa si alguien incumple estas condiciones");
    expect(es).toContain(
      "Cualquier jugador puede denunciar una foto o un mensaje del chat, y silenciar a un jugador para dejar de ver sus mensajes del chat y sus reacciones con emojis.",
    );
    // Muting hides no photo (DEC-063): the round photo is everyone's while answering
    expect(en).not.toContain("photos and messages");
    expect(es).not.toContain("fotos y mensajes");
    expect(es).toContain("El anfitrión puede expulsar a un jugador de la sala.");
    expect(es).toContain("Revisamos las denuncias.");
    expect(es).toContain("El contenido ilegal, como el material de abuso sexual infantil, puede denunciarse ante las autoridades.");
  });

  it("links the privacy policy in the same language", () => {
    expect(render("en")).toContain('<a href="/privacy?lang=en">privacy policy</a>');
    expect(render("es")).toContain('<a href="/privacy?lang=es">política de privacidad</a>');
  });

  it("without a contact address → a neutral pointer to the store page, no mailto", () => {
    expect(section(render("en"), "Contact")).toContain("use the developer contact shown on the app's store page");
    expect(section(render("es"), "Contacto")).toContain("usa el contacto del desarrollador que aparece en la ficha de la app");
    expect(render("en")).not.toContain("mailto:");
  });

  it("with a contact address → a mailto link, HTML-escaped", () => {
    const page = render("en", `"<b>x</b>"&y@example.com`);
    expect(section(page, "Contact")).toContain(
      `write to <a href="mailto:&quot;&lt;b&gt;x&lt;/b&gt;&quot;&amp;y@example.com">&quot;&lt;b&gt;x&lt;/b&gt;&quot;&amp;y@example.com</a>`,
    );
    expect(page).not.toContain("<b>x</b>");
  });

  // The app picks the photo at random: the way to keep other people's photos out is a limited selection
  it("says how to keep photos of other people out of the game", () => {
    expect(section(render("en"), "What is not allowed")).toContain(
      "The app picks your photos at random: to keep such photos out of the game, allow access only to a selection of photos without them.",
    );
    expect(section(render("es"), "Qué no está permitido")).toContain(
      "La app elige tus fotos al azar: para dejar esas fotos fuera del juego, permite el acceso solo a una selección de fotos sin ellas.",
    );
  });

  it("says players accept the terms again when they change", () => {
    expect(render("en")).toContain("the app will ask you to accept them again");
    expect(render("es")).toContain("la app te pedirá que las aceptes de nuevo");
  });

  it("shows the last-updated date in the page language", () => {
    expect(render("en")).toContain(`<time datetime="${TERMS_LAST_UPDATED}">November 8, 2026</time>`);
    expect(render("es")).toContain(`<time datetime="${TERMS_LAST_UPDATED}">8 de noviembre de 2026</time>`);
  });

  it("is script-free", () => {
    expect(render("es", "contact@example.com")).not.toMatch(/<script/i);
  });
});
