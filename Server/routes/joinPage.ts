// ── Invite page (/join/:code) ──
// What someone opening an invite link sees in a browser: the code, a button that opens the app on its deep link, and
// links to install the app for people who don't have it yet. Spanish or English (from Accept-Language); the store
// links depend on the device (from User-Agent). The route sets the CSP that lets only the page's nonce script run.

/** The app's deep link scheme (Client/app.json `expo.scheme`). */
export const APP_SCHEME = "exposeme";
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.socketNull.ExposeMe";
/** App Store ids are numeric (apps.apple.com/app/id<digits>). */
const APP_STORE_ID_SHAPE = /^\d{1,20}$/;

/** The App Store id of an APP_STORE_ID value, or null when unset or not numeric (logged): then no App Store link. */
export function parseAppStoreId(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (APP_STORE_ID_SHAPE.test(value)) return value;
  console.warn(`[config] ignoring APP_STORE_ID=${JSON.stringify(raw)} (expected the app's numeric App Store id)`);
  return null;
}

export const APP_STORE_ID = parseAppStoreId(process.env.APP_STORE_ID);
export const appStoreUrl = (appStoreId: string) => `https://apps.apple.com/app/id${appStoreId}`;

// ── Language ──

export type InviteLanguage = "en" | "es";
/** In negotiation order: the first one is the default when the browser accepts neither. */
export const INVITE_LANGUAGES: readonly InviteLanguage[] = ["en", "es"];

/** The page language for the result of `req.acceptsLanguages(...INVITE_LANGUAGES)`. */
export const pickInviteLanguage = (accepted: string | false): InviteLanguage =>
  INVITE_LANGUAGES.find((language) => language === accepted) ?? INVITE_LANGUAGES[0];

const TEXT: Record<InviteLanguage, Record<
  "title" | "invited" | "openInApp" | "enterManually" | "noAppYet" | "googlePlay" | "appStore" | "appStoreSoon",
  string
>> = {
  en: {
    title: "Join an ExposeMe game",
    invited: "You've been invited to a game!",
    openInApp: "Open in the app",
    enterManually: "If the app doesn't open, enter the code in it manually.",
    noAppYet: "Don't have the app yet?",
    googlePlay: "Get it on Google Play",
    appStore: "Download on the App Store",
    appStoreSoon: "Coming soon to the App Store",
  },
  es: {
    title: "Únete a una partida de ExposeMe",
    invited: "¡Te han invitado a una partida!",
    openInApp: "Abrir en la app",
    enterManually: "Si la app no se abre, introduce el código en ella a mano.",
    noAppYet: "¿Aún no tienes la app?",
    googlePlay: "Disponible en Google Play",
    appStore: "Descárgalo en el App Store",
    appStoreSoon: "Pronto en el App Store",
  },
};

// ── Device ──

export type InvitePlatform = "android" | "ios" | "desktop";

/**
 * The store the visitor's device installs from. iPadOS Safari reports a Mac by default, so an iPad may count as
 * desktop: it then gets both stores, which still includes its own.
 */
export function platformOf(userAgent: string | undefined): InvitePlatform {
  if (!userAgent) return "desktop";
  if (/\bAndroid\b/i.test(userAgent)) return "android";
  if (/\b(iPhone|iPad|iPod)\b/i.test(userAgent)) return "ios";
  return "desktop";
}

// ── HTML ──

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// JSON string literal safe to embed inside an inline <script>
const toScriptString = (value: string) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const storeLink = (url: string, label: string) => `<a class="store" href="${escapeHtml(url)}">${label}</a>`;

/**
 * Store links for the device: Google Play on Android, the App Store on iOS, both on anything else. Without an App
 * Store id the iOS slot is a "coming soon" note instead, so an iPhone visitor isn't left wondering where the app is.
 */
function storeLinks(platform: InvitePlatform, appStoreId: string | null, text: (typeof TEXT)[InviteLanguage]): string[] {
  const links: string[] = [];
  if (platform !== "ios") links.push(storeLink(PLAY_STORE_URL, text.googlePlay));
  if (platform !== "android") {
    links.push(appStoreId ? storeLink(appStoreUrl(appStoreId), text.appStore) : `<p class="soon">${text.appStoreSoon}</p>`);
  }
  return links;
}

export interface JoinPageOptions {
  /** A valid room code (the route rejects anything else); escaped anyway. */
  code: string;
  language: InviteLanguage;
  platform: InvitePlatform;
  appStoreId: string | null;
  /** Nonce of the page's only script, the same one the route puts in its CSP. */
  nonce: string;
}

/** The deep link that opens the app in the waiting room of `code`. */
export const joinDeepLink = (code: string) => `${APP_SCHEME}://screens/WaitingRoom?code=${encodeURIComponent(code)}`;

/** The invite page. Mobile browsers try the deep link right away; the page stays as the fallback. */
export function renderJoinPage({ code, language, platform, appStoreId, nonce }: JoinPageOptions): string {
  const text = TEXT[language];
  const deepLink = joinDeepLink(code);
  return `
    <!DOCTYPE html>
    <html lang="${language}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${text.title}</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #111; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
        .card { text-align: center; padding: 2rem; }
        .code { font-size: 3rem; font-weight: 900; letter-spacing: 6px; margin: 1rem 0; }
        .btn { display: inline-block; background: #e9042e; color: #fff; padding: 14px 32px; border-radius: 999px; text-decoration: none; font-weight: 700; font-size: 1.1rem; margin-top: 1rem; }
        .sub { opacity: 0.6; font-size: 0.9rem; margin-top: 1.5rem; }
        .stores { display: flex; flex-direction: column; align-items: center; gap: 0.75rem; margin-top: 0.75rem; }
        .store { display: inline-block; border: 1px solid #fff; color: #fff; padding: 10px 24px; border-radius: 999px; text-decoration: none; font-weight: 600; }
        .soon { opacity: 0.6; margin: 0; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>ExposeMe</h1>
        <p>${text.invited}</p>
        <div class="code">${escapeHtml(code)}</div>
        <a class="btn" href="${escapeHtml(deepLink)}">${text.openInApp}</a>
        <p class="sub">${text.enterManually}</p>
        <p class="sub">${text.noAppYet}</p>
        <div class="stores">${storeLinks(platform, appStoreId, text).join("")}</div>
      </div>
      <script nonce="${escapeHtml(nonce)}">window.location.href = ${toScriptString(deepLink)};</script>
    </body>
    </html>
  `;
}
