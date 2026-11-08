import { Request, Response } from "express";
import { STATIC_PAGE_CSP } from "../middlewares/securityHeaders";
import { escapeHtml, INVITE_LANGUAGES, InviteLanguage, pickInviteLanguage } from "./joinPage";

// ── Legal pages (/privacy, /terms) ──
// The shared shell of the static legal pages: plain HTML in Spanish or English with an inline style and no script,
// a "last updated" date and a list of sections. Each page brings its own text (routes/privacyPage, routes/termsPage).

export interface LegalSection {
  heading: string;
  /** HTML paragraphs */
  paragraphs: string[];
}

export interface LegalPageContent {
  language: InviteLanguage;
  title: string;
  /** The label before the date, e.g. "Last updated:" */
  lastUpdatedLabel: string;
  /** ISO date of the last change to what the page says */
  lastUpdated: string;
  sections: LegalSection[];
}

// ── Language ──

/** `?lang=es|en` wins; anything else (missing, unknown, repeated) falls back to the browser's Accept-Language. */
export function pickLegalPageLanguage(langQuery: unknown, accepted: string | false): InviteLanguage {
  const requested = INVITE_LANGUAGES.find((language) => language === langQuery);
  return requested ?? pickInviteLanguage(accepted);
}

/** The page language for a request (?lang=es|en overrides Accept-Language). */
export const legalPageLanguageOf = (req: Request): InviteLanguage =>
  pickLegalPageLanguage(req.query.lang, req.acceptsLanguages(...INVITE_LANGUAGES));

// ── HTML ──

export const mailtoLink = (email: string) => `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`;

const formatDate = (isoDate: string, language: InviteLanguage) =>
  new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" }).format(new Date(isoDate));

const renderSection = ({ heading, paragraphs }: LegalSection) =>
  `<h2>${heading}</h2>${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}`;

export function renderLegalPage({ language, title, lastUpdatedLabel, lastUpdated, sections }: LegalPageContent): string {
  return `
    <!DOCTYPE html>
    <html lang="${language}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${title}</title>
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
        <h1>${title}</h1>
        <p class="updated">${lastUpdatedLabel} <time datetime="${lastUpdated}">${formatDate(lastUpdated, language)}</time></p>
        ${sections.map(renderSection).join("\n        ")}
      </main>
    </body>
    </html>
  `;
}

// ── Response ──

/** How long browsers and caches may reuse a legal page: it only changes with a deploy. */
const LEGAL_PAGE_CACHE_CONTROL = "public, max-age=3600";

/** Sends a rendered legal page with its cache and script-free CSP headers. */
export function sendLegalPage(res: Response, html: string): void {
  // Same URL, different language per Accept-Language: a cache must keep one copy per language
  res.vary("Accept-Language");
  res.setHeader("Cache-Control", LEGAL_PAGE_CACHE_CONTROL);
  res.setHeader("Content-Security-Policy", STATIC_PAGE_CSP);
  res.type("html").send(html);
}
