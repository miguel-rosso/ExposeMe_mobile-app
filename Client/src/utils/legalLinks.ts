import { Linking } from "react-native";
import getEnvVars from "../../config";
import type { Lang } from "../i18n/context";

// ── Privacy policy and contact (EXP-426) ──
// The game server serves the privacy policy at /privacy (in Spanish or English with ?lang=), so the app links the
// server it plays on: production in store builds, the QA lab server when EXPO_PUBLIC_SERVER_URL points at it.

/** Path of the privacy policy page on the game server */
const PRIVACY_PATH = "/privacy";

/** The privacy policy page in the app's language, on the given game server (by default the one the app plays on). */
export const privacyPolicyUrl = (lang: Lang, serverUrl: string = getEnvVars().SERVER_URL): string =>
  `${serverUrl.replace(/\/+$/, "")}${PRIVACY_PATH}?lang=${lang}`;

// ── Contact address ──

/** Longest address allowed by the SMTP path limit (RFC 5321), as the server's CONTACT_EMAIL check */
const EMAIL_MAX_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address of an EXPO_PUBLIC_CONTACT_EMAIL value, or null when unset or not an email address. */
export const parseContactEmail = (raw: string | undefined): string | null => {
  const value = raw?.trim();
  if (!value || value.length > EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(value)) return null;
  return value;
};

/**
 * The contact address the build was made with, or null: then the app shows no contact row. Read at call time (Expo
 * inlines the EXPO_PUBLIC_ value at build time, so it never changes on a device; tests can set it).
 */
export const contactEmail = (): string | null => parseContactEmail(process.env.EXPO_PUBLIC_CONTACT_EMAIL);

export const contactMailtoUrl = (email: string): string => `mailto:${email}`;

// ── Opening ──

/** Opens a link in the app that handles it (browser, mail app); false when none could (e.g. no mail app set up). */
export const openExternalLink = async (url: string): Promise<boolean> => {
  try {
    await Linking.openURL(url);
    return true;
  } catch (error) {
    console.warn(`[links] could not open ${url}`, error);
    return false;
  }
};
