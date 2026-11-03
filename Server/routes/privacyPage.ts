import { Request, Response } from "express";
import { STATIC_PAGE_CSP } from "../middlewares/securityHeaders";
import { UPLOAD_TTL_MS } from "../middlewares/uploadSweeper";
import { escapeHtml, INVITE_LANGUAGES, InviteLanguage, pickInviteLanguage } from "./joinPage";

// ── Privacy policy page (/privacy) ──
// The policy both stores require, in Spanish or English (Accept-Language, or ?lang=es|en to link one directly). Plain
// HTML with an inline style and no script. Every fact in it comes from the code: keep it in sync when what the app
// sends, who sees it or how long the server keeps it changes, and bump PRIVACY_LAST_UPDATED.

/** Date of the last change to what the policy says (ISO, shown in the page language). */
export const PRIVACY_LAST_UPDATED = "2026-11-03";

/** Photos are deleted from the server at the latest this long after upload (the upload sweeper's TTL). */
const PHOTO_TTL_MINUTES = Math.round(UPLOAD_TTL_MS / 60_000);

// ── Configuration ──

/** Longest address allowed by the SMTP path limit (RFC 5321). */
const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The contact address of a CONTACT_EMAIL value, or null when unset or not an address (logged): then no address is shown. */
export function parseContactEmail(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.length <= EMAIL_MAX_LENGTH && EMAIL_SHAPE.test(value)) return value;
  console.warn(`[config] ignoring CONTACT_EMAIL=${JSON.stringify(raw)} (expected an email address)`);
  return null;
}

/**
 * The publisher named as responsible for the data, or null when CONTROLLER_NAME is unset: then the page points to the
 * developer shown on the store listing. Unset in production is logged, as the policy should name them.
 */
export function parseControllerName(raw: string | undefined, production: boolean): string | null {
  const value = raw?.trim();
  if (value) return value;
  if (production) console.warn("[config] CONTROLLER_NAME is unset: the privacy policy names no publisher");
  return null;
}

export const CONTACT_EMAIL = parseContactEmail(process.env.CONTACT_EMAIL);
export const CONTROLLER_NAME = parseControllerName(process.env.CONTROLLER_NAME, process.env.NODE_ENV === "production");

// ── Language ──

/** `?lang=es|en` wins; anything else (missing, unknown, repeated) falls back to the browser's Accept-Language. */
export function pickPrivacyLanguage(langQuery: unknown, accepted: string | false): InviteLanguage {
  const requested = INVITE_LANGUAGES.find((language) => language === langQuery);
  return requested ?? pickInviteLanguage(accepted);
}

// ── Text ──

interface PolicyFacts {
  /** Already HTML-escaped; null when no publisher is configured */
  controller: string | null;
  /** HTML of the contact line's address: a mailto link, or null when no address is configured */
  contactLink: string | null;
  photoTtlMinutes: number;
}

interface Section {
  heading: string;
  /** HTML paragraphs */
  paragraphs: string[];
}

interface PolicyText {
  title: string;
  lastUpdated: string;
  sections: (facts: PolicyFacts) => Section[];
}

const TEXT: Record<InviteLanguage, PolicyText> = {
  en: {
    title: "ExposeMe privacy policy",
    lastUpdated: "Last updated:",
    sections: ({ controller, contactLink, photoTtlMinutes }) => [
      {
        heading: "In short",
        paragraphs: [
          "ExposeMe is a party game: each round shows a photo from one player's gallery and the others guess whose it is.",
          `There are no accounts, no ads and no analytics or tracking. What you share in a game is only for the players in that game, and its photos are deleted from the server within ${photoTtlMinutes} minutes at the latest. We don't sell or share your data.`,
        ],
      },
      {
        heading: "Who is responsible",
        paragraphs: [
          controller
            ? `${controller} publishes ExposeMe and is responsible for the data described here.`
            : "ExposeMe's publisher, the developer shown on the app's store page, is responsible for the data described here.",
          contactLink
            ? `For any question or request about your data, write to ${contactLink}.`
            : "For any question or request about your data, use the developer contact shown on the app's store page.",
        ],
      },
      {
        heading: "Your photo gallery",
        paragraphs: [
          "The app asks for permission to read your photo gallery, because the game is played with photos from the players' galleries. It only reads photos (no videos) and doesn't use the camera, the microphone or your location. On iPhone you can allow only a selection of photos; the app then picks only among those.",
          "Your gallery is browsed on your phone. The only photos that leave it are the one the app picks at random from the photos it can access when it is your turn, and the one you choose yourself to plant in the game. Before sending a photo the app makes a smaller JPEG copy of it, and the server removes all its metadata (such as the date, the camera or the GPS location) before storing it.",
          "You can withdraw the permission at any time in your phone's settings; without it you can't take part in a game.",
        ],
      },
      {
        heading: "What else the game uses",
        paragraphs: [
          "<strong>Your player name</strong>: the one you type. The other players in your room see it, and the server's game logs record it with the room code (who joined, whose photo each round showed).",
          "<strong>Chat messages and reactions</strong>: sent to the players in your room at that moment and not stored by the server. If you take a screenshot during a game, the other players get a reaction saying so; the screenshot itself is not sent.",
          "<strong>Your IP address</strong>: like any internet service, the server sees it. It only uses it in memory, to limit abuse (too many requests or connections), and doesn't write it to its logs. Our hosting provider may record it in its own request logs.",
          "<strong>On your phone</strong>: the app saves your name, your language and a code to rejoin your last game. They stay on your phone.",
        ],
      },
      {
        heading: "Who sees it",
        paragraphs: [
          "Only the players in your game room see your photos, your name and your messages: the server sends a photo only to members of the room it was taken in. Keep in mind that other players can take screenshots.",
          // TODO(owner): name the Render region the service runs in (and, if it is outside the EU, the transfer safeguard)
          "The server is hosted by Render Services, Inc. (United States), which processes this data on our behalf only to run it. Nobody else gets it, and nothing is used for advertising.",
        ],
      },
      {
        heading: "How long it is kept",
        paragraphs: [
          `<strong>Photos</strong>: deleted from the server when the game ends, when the room empties or when you leave it (the one on screen at that moment once its round ends), and in any case within ${photoTtlMinutes} minutes after being sent.`,
          "<strong>Rooms and player names</strong>: held only in the server's memory while the room exists. Chat messages are only relayed, never kept.",
          "<strong>Server logs</strong>: game events with room codes and player names, never photos, messages or IP addresses. Our hosting provider keeps them for a limited time, for troubleshooting.",
        ],
      },
      {
        heading: "Your rights",
        paragraphs: [
          "Legal basis: we use this data to provide the game you ask to play (GDPR art. 6(1)(b)), and, for the abuse limits and the server logs, our legitimate interest in keeping the service safe and working (art. 6(1)(f)).",
          "You can ask to access or delete your data, or object to its use, by contacting us. As there are no accounts and photos are deleted within minutes, there is usually nothing left that we could link to you. You can also complain to your data protection authority.",
        ],
      },
      {
        heading: "Children",
        paragraphs: [
          "ExposeMe is not directed at children under 13, or under the minimum age set by the law of their country (up to 16 in the European Union). If you believe a child has used it, contact us.",
        ],
      },
      {
        heading: "Changes",
        paragraphs: ["If this policy changes, we will update this page and the date at the top."],
      },
    ],
  },
  es: {
    title: "Política de privacidad de ExposeMe",
    lastUpdated: "Última actualización:",
    sections: ({ controller, contactLink, photoTtlMinutes }) => [
      {
        heading: "En resumen",
        paragraphs: [
          "ExposeMe es un juego de fiesta: en cada ronda se muestra una foto de la galería de un jugador y el resto adivina de quién es.",
          `No hay cuentas, ni anuncios, ni analítica ni seguimiento. Lo que compartes en una partida es solo para los jugadores de esa partida, y sus fotos se borran del servidor como máximo ${photoTtlMinutes} minutos después. No vendemos ni compartimos tus datos.`,
        ],
      },
      {
        heading: "Quién es el responsable",
        paragraphs: [
          controller
            ? `${controller} publica ExposeMe y es responsable de los datos que se describen aquí.`
            : "El editor de ExposeMe, el desarrollador que aparece en la ficha de la app en la tienda, es responsable de los datos que se describen aquí.",
          contactLink
            ? `Para cualquier pregunta o solicitud sobre tus datos, escribe a ${contactLink}.`
            : "Para cualquier pregunta o solicitud sobre tus datos, usa el contacto del desarrollador que aparece en la ficha de la app en la tienda.",
        ],
      },
      {
        heading: "Tu galería de fotos",
        paragraphs: [
          "La app pide permiso para leer tu galería, porque el juego se juega con fotos de las galerías de los jugadores. Solo lee fotos (no vídeos) y no usa la cámara, el micrófono ni tu ubicación. En iPhone puedes permitir solo una selección de fotos; la app elige entonces solo entre esas.",
          "Tu galería se recorre en tu móvil. Las únicas fotos que salen de él son la que la app elige al azar entre las que puede ver cuando te toca, y la que eliges tú para colar en la partida. Antes de enviar una foto la app hace una copia JPEG más pequeña, y el servidor le quita todos los metadatos (como la fecha, la cámara o la ubicación GPS) antes de guardarla.",
          "Puedes retirar el permiso cuando quieras en los ajustes del móvil; sin él no puedes jugar una partida.",
        ],
      },
      {
        heading: "Qué más usa el juego",
        paragraphs: [
          "<strong>Tu nombre de jugador</strong>: el que escribes. Lo ven los demás jugadores de tu sala, y los registros de partida del servidor lo anotan junto al código de la sala (quién entra, de quién es la foto de cada ronda).",
          "<strong>Mensajes del chat y reacciones</strong>: se envían a los jugadores de tu sala en ese momento y el servidor no los guarda. Si haces una captura de pantalla durante una partida, los demás jugadores reciben una reacción que lo indica; la captura en sí no se envía.",
          "<strong>Tu dirección IP</strong>: como cualquier servicio de internet, el servidor la ve. Solo la usa en memoria, para limitar abusos (demasiadas peticiones o conexiones), y no la escribe en sus registros. Nuestro proveedor de alojamiento puede anotarla en sus propios registros de peticiones.",
          "<strong>En tu móvil</strong>: la app guarda tu nombre, tu idioma y un código para volver a tu última partida. Se quedan en tu móvil.",
        ],
      },
      {
        heading: "Quién lo ve",
        paragraphs: [
          "Solo los jugadores de tu sala ven tus fotos, tu nombre y tus mensajes: el servidor solo envía una foto a los miembros de la sala en la que se subió. Ten en cuenta que los demás jugadores pueden hacer capturas de pantalla.",
          // TODO(owner): same region as the English text
          "El servidor está alojado en Render Services, Inc. (Estados Unidos), que trata estos datos en nuestro nombre solo para hacerlo funcionar. Nadie más los recibe y nada se usa para publicidad.",
        ],
      },
      {
        heading: "Cuánto tiempo se guarda",
        paragraphs: [
          `<strong>Fotos</strong>: se borran del servidor cuando termina la partida, cuando la sala se vacía o cuando la abandonas (la que está en pantalla en ese momento, al acabar su ronda), y en cualquier caso como máximo ${photoTtlMinutes} minutos después de enviarlas.`,
          "<strong>Salas y nombres de jugador</strong>: solo están en la memoria del servidor mientras existe la sala. Los mensajes del chat solo se reenvían, nunca se guardan.",
          "<strong>Registros del servidor</strong>: eventos de partida con códigos de sala y nombres de jugador, nunca fotos, mensajes ni direcciones IP. Nuestro proveedor de alojamiento los conserva durante un tiempo limitado, para resolver problemas.",
        ],
      },
      {
        heading: "Tus derechos",
        paragraphs: [
          "Base legal: usamos estos datos para prestarte el juego al que pides jugar (art. 6.1.b del RGPD) y, para los límites contra abusos y los registros del servidor, por nuestro interés legítimo en mantener el servicio seguro y en funcionamiento (art. 6.1.f).",
          "Puedes pedir acceder a tus datos o borrarlos, u oponerte a su uso, contactando con nosotros. Como no hay cuentas y las fotos se borran en minutos, normalmente no queda nada que podamos relacionar contigo. También puedes reclamar ante tu autoridad de protección de datos.",
        ],
      },
      {
        heading: "Menores",
        paragraphs: [
          "ExposeMe no está dirigida a menores de 13 años, o de la edad mínima que fije la ley de su país (hasta 16 en la Unión Europea). Si crees que un menor la ha usado, contacta con nosotros.",
        ],
      },
      {
        heading: "Cambios",
        paragraphs: ["Si esta política cambia, actualizaremos esta página y la fecha del principio."],
      },
    ],
  },
};

// ── HTML ──

export interface PrivacyPageOptions {
  language: InviteLanguage;
  /** Escaped here; null points to the developer shown on the store page instead */
  controllerName: string | null;
  /** Escaped here; null shows a pointer to the store page's developer contact instead */
  contactEmail: string | null;
}

const formatDate = (isoDate: string, language: InviteLanguage) =>
  new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" }).format(new Date(isoDate));

const mailtoLink = (email: string) => `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`;

const renderSection = ({ heading, paragraphs }: Section) =>
  `<h2>${heading}</h2>${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}`;

export function renderPrivacyPage({ language, controllerName, contactEmail }: PrivacyPageOptions): string {
  const text = TEXT[language];
  const sections = text.sections({
    controller: controllerName ? escapeHtml(controllerName) : null,
    contactLink: contactEmail ? mailtoLink(contactEmail) : null,
    photoTtlMinutes: PHOTO_TTL_MINUTES,
  });
  return `
    <!DOCTYPE html>
    <html lang="${language}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${text.title}</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #111; color: #eee; margin: 0; line-height: 1.55; }
        main { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
        h1 { color: #fff; margin-bottom: 0.25rem; }
        h2 { color: #fff; font-size: 1.15rem; margin-top: 2rem; }
        a { color: #ff5c7a; }
        .updated { opacity: 0.6; font-size: 0.9rem; margin-top: 0; }
      </style>
    </head>
    <body>
      <main>
        <h1>${text.title}</h1>
        <p class="updated">${text.lastUpdated} <time datetime="${PRIVACY_LAST_UPDATED}">${formatDate(PRIVACY_LAST_UPDATED, language)}</time></p>
        ${sections.map(renderSection).join("\n        ")}
      </main>
    </body>
    </html>
  `;
}

// ── Route ──

/** How long browsers and caches may reuse the page: it only changes with a deploy. */
const PRIVACY_CACHE_CONTROL = "public, max-age=3600";

/** GET /privacy: the policy in the visitor's language (?lang=es|en overrides Accept-Language). */
export function servePrivacyPage(req: Request, res: Response): void {
  // Same URL, different language per Accept-Language: a cache must keep one copy per language
  res.vary("Accept-Language");
  res.setHeader("Cache-Control", PRIVACY_CACHE_CONTROL);
  res.setHeader("Content-Security-Policy", STATIC_PAGE_CSP);
  res.type("html").send(
    renderPrivacyPage({
      language: pickPrivacyLanguage(req.query.lang, req.acceptsLanguages(...INVITE_LANGUAGES)),
      controllerName: CONTROLLER_NAME,
      contactEmail: CONTACT_EMAIL,
    }),
  );
}
