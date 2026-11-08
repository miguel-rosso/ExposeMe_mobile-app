import { Request, Response } from "express";
import { escapeHtml, InviteLanguage } from "./joinPage";
import { LegalSection, legalPageLanguageOf, mailtoLink, renderLegalPage, sendLegalPage } from "./legalPage";
import { CONTACT_EMAIL } from "./privacyPage";

// ── Terms of use page (/terms) ──
// What players accept on the app's first screen before they share anything (DEC-058): the content that is not allowed
// in photos, chat messages and player names, and what happens to it. In Spanish or English (Accept-Language, or
// ?lang=es|en), in the shared legal page shell (routes/legalPage). The terms say what is not allowed; moderation stays
// per player (report, mute) and per room (the host kicks), there is no automatic filter. When what they say changes,
// bump TERMS_LAST_UPDATED and the app's TERMS_VERSION (Client/src/utils/termsAcceptance.ts; termsPage.test.ts checks
// they match), so players accept again.

/** Date of the last change to what the terms say (ISO, shown in the page language). */
export const TERMS_LAST_UPDATED = "2026-11-08";

/** Path of the privacy policy the terms link to, in the same language */
const PRIVACY_PATH = "/privacy";

// ── Text ──

interface TermsFacts {
  /** HTML of the contact line's address: a mailto link, or null when no address is configured */
  contactLink: string | null;
  /** Already HTML-escaped */
  privacyHref: string;
}

interface TermsText {
  title: string;
  lastUpdated: string;
  sections: (facts: TermsFacts) => LegalSection[];
}

const TEXT: Record<InviteLanguage, TermsText> = {
  en: {
    title: "ExposeMe terms of use",
    lastUpdated: "Last updated:",
    sections: ({ contactLink, privacyHref }) => [
      {
        heading: "In short",
        paragraphs: [
          "ExposeMe is a party game: each round shows a random photo from one player's gallery and the others guess whose it is. In a game you share photos from your gallery, chat messages and your player name with the other players in your room.",
          "By using ExposeMe you accept these terms. If you don't, don't use the app.",
        ],
      },
      {
        heading: "What is not allowed",
        paragraphs: [
          "In photos, chat messages and player names, don't share:",
          "<strong>Nudity or sexual content.</strong>",
          "<strong>Anything involving minors</strong> that sexualises, exploits or endangers them.",
          "<strong>Harassment or bullying</strong>: insulting, threatening or humiliating someone.",
          "<strong>Hate</strong>: attacks on people for their origin, ethnicity, religion, sex, sexual orientation, gender identity, disability or any similar trait.",
          "<strong>Violence</strong>: graphic violence, or threats or encouragement of violence.",
          "<strong>Photos of other people without their permission.</strong> The app picks your photos at random: to keep such photos out of the game, allow access only to a selection of photos without them.",
        ],
      },
      {
        heading: "Your gallery",
        paragraphs: [
          "Any photo the app can access may come up in a game, at random. You are responsible for what you share: if your gallery has photos you wouldn't show, allow access only to a selection of photos.",
        ],
      },
      {
        heading: "What happens if someone breaks these terms",
        paragraphs: [
          "Any player can report a photo or a chat message, and mute a player to stop seeing their chat messages and emoji reactions. The host can kick a player out of the room.",
          "We review reports. Illegal content, such as child sexual abuse material, may be reported to the authorities.",
        ],
      },
      {
        heading: "Your data",
        paragraphs: [`What the app sends and how long it is kept is explained in the <a href="${privacyHref}">privacy policy</a>.`],
      },
      {
        heading: "Contact",
        paragraphs: [
          contactLink
            ? `To report a problem or ask about these terms, write to ${contactLink}.`
            : "To report a problem or ask about these terms, use the developer contact shown on the app's store page.",
        ],
      },
      {
        heading: "Changes",
        paragraphs: ["If these terms change, we will update this page and its date, and the app will ask you to accept them again."],
      },
    ],
  },
  es: {
    title: "Condiciones de uso de ExposeMe",
    lastUpdated: "Última actualización:",
    sections: ({ contactLink, privacyHref }) => [
      {
        heading: "En resumen",
        paragraphs: [
          "ExposeMe es un juego de fiesta: en cada ronda sale una foto al azar de la galería de un jugador y los demás adivinan de quién es. En una partida compartes fotos de tu galería, mensajes de chat y tu nombre de jugador con los demás jugadores de tu sala.",
          "Al usar ExposeMe aceptas estas condiciones. Si no las aceptas, no uses la app.",
        ],
      },
      {
        heading: "Qué no está permitido",
        paragraphs: [
          "En fotos, mensajes de chat y nombres de jugador, no compartas:",
          "<strong>Desnudos ni contenido sexual.</strong>",
          "<strong>Nada con menores</strong> que los sexualice, los explote o los ponga en peligro.",
          "<strong>Acoso</strong>: insultar, amenazar o humillar a alguien.",
          "<strong>Odio</strong>: ataques a personas por su origen, etnia, religión, sexo, orientación sexual, identidad de género, discapacidad o cualquier rasgo similar.",
          "<strong>Violencia</strong>: violencia explícita, o amenazas o incitación a la violencia.",
          "<strong>Fotos de otras personas sin su permiso.</strong> La app elige tus fotos al azar: para dejar esas fotos fuera del juego, permite el acceso solo a una selección de fotos sin ellas.",
        ],
      },
      {
        heading: "Tu galería",
        paragraphs: [
          "Cualquier foto a la que la app pueda acceder puede salir en una partida, al azar. Eres responsable de lo que compartes: si tu galería tiene fotos que no enseñarías, permite el acceso solo a una selección de fotos.",
        ],
      },
      {
        heading: "Qué pasa si alguien incumple estas condiciones",
        paragraphs: [
          "Cualquier jugador puede denunciar una foto o un mensaje del chat, y silenciar a un jugador para dejar de ver sus mensajes del chat y sus reacciones con emojis. El anfitrión puede expulsar a un jugador de la sala.",
          "Revisamos las denuncias. El contenido ilegal, como el material de abuso sexual infantil, puede denunciarse ante las autoridades.",
        ],
      },
      {
        heading: "Tus datos",
        paragraphs: [`Qué envía la app y cuánto tiempo se guarda se explica en la <a href="${privacyHref}">política de privacidad</a>.`],
      },
      {
        heading: "Contacto",
        paragraphs: [
          contactLink
            ? `Para avisar de un problema o preguntar por estas condiciones, escribe a ${contactLink}.`
            : "Para avisar de un problema o preguntar por estas condiciones, usa el contacto del desarrollador que aparece en la ficha de la app en la tienda.",
        ],
      },
      {
        heading: "Cambios",
        paragraphs: ["Si estas condiciones cambian, actualizaremos esta página y su fecha, y la app te pedirá que las aceptes de nuevo."],
      },
    ],
  },
};

// ── HTML ──

export interface TermsPageOptions {
  language: InviteLanguage;
  /** Escaped here; null shows a pointer to the store page's developer contact instead */
  contactEmail: string | null;
}

export function renderTermsPage({ language, contactEmail }: TermsPageOptions): string {
  const text = TEXT[language];
  return renderLegalPage({
    language,
    title: text.title,
    lastUpdatedLabel: text.lastUpdated,
    lastUpdated: TERMS_LAST_UPDATED,
    sections: text.sections({
      contactLink: contactEmail ? mailtoLink(contactEmail) : null,
      privacyHref: escapeHtml(`${PRIVACY_PATH}?lang=${language}`),
    }),
  });
}

// ── Route ──

/** GET /terms: the terms of use in the visitor's language (?lang=es|en overrides Accept-Language). */
export function serveTermsPage(req: Request, res: Response): void {
  sendLegalPage(res, renderTermsPage({ language: legalPageLanguageOf(req), contactEmail: CONTACT_EMAIL }));
}
