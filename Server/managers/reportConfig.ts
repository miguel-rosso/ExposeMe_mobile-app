import { envInt } from "../middlewares/rateLimit";

// ── Report settings from the environment (EXP-423) ──
// Read by the report store (managers/reportStore) and stated by the privacy policy (routes/privacyPage), which must
// say how long reports are kept and whether they also go to a webhook.

/** Days a report (and its photo copy) is kept before it is purged. */
export const REPORT_RETENTION_DAYS = envInt("REPORT_RETENTION_DAYS", 90, 1, 3650);

/**
 * Bytes the photos kept for reports may take in all, server-wide (they share the disk with the uploads). Photos are
 * ≤ 2048 px (~1 MB), so the default keeps a few hundred; past it reports are stored without their photo.
 */
export const REPORT_PHOTOS_MAX_BYTES = envInt("REPORT_PHOTOS_MAX_BYTES", 500 * 1024 * 1024, 0, 100 * 1024 ** 3);

/** The webhook of a REPORT_WEBHOOK_URL value: an http(s) URL, or null when unset or anything else (logged, never echoed). */
export function parseWebhookUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch { /* not a URL: same warning */ }
  // The URL itself often carries a secret token: never log it
  console.warn("[config] ignoring REPORT_WEBHOOK_URL (not an http(s) URL)");
  return null;
}

/** Where each report's summary is POSTed, or null: no notification. */
export const REPORT_WEBHOOK_URL = parseWebhookUrl(process.env.REPORT_WEBHOOK_URL);
