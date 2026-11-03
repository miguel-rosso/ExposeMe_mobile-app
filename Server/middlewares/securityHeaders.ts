import { NextFunction, Request, Response } from "express";

// ── Security headers ──
// This server answers JSON, uploaded images and two small HTML pages (/join/:code, /privacy), so every response
// gets a deny-all CSP; the pages override it with joinPageCsp() / STATIC_PAGE_CSP. Set manually (no helmet dependency).
// CORP same-site only affects browsers: React Native's image loader is not subject to it.
// HSTS: production runs behind Render's HTTPS, and browsers ignore the header on plain-HTTP responses (local
// dev/QA), so it is harmless there. No includeSubDomains/preload: the host is a shared onrender.com subdomain.

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** CSP for the /join invite page: its inline <style> plus only the inline <script> carrying `nonce`. */
export const joinPageCsp = (nonce: string) =>
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

/** CSP for a script-free HTML page (/privacy): only its inline <style>. */
export const STATIC_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", API_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
}

/** Final JSON 404 for routes nothing else matched (Express' default is an HTML page echoing the path). */
export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}
