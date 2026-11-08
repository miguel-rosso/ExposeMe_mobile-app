import { Linking } from "react-native";
import getEnvVars from "../../config";
import type { Lang } from "../i18n/context";

// ── Privacy policy, terms of use and contact (EXP-426, EXP-433) ──
// The game server serves the privacy policy at /privacy and the terms of use at /terms (in Spanish or English with
// ?lang=), so the app links the server it plays on: production in store builds, the QA lab server when
// EXPO_PUBLIC_SERVER_URL points at it.

/** Path of the privacy policy page on the game server */
const PRIVACY_PATH = "/privacy";
/** Path of the terms of use page on the game server */
const TERMS_PATH = "/terms";

/** A legal page of the game server in the app's language. */
const serverPageUrl = (path: string, lang: Lang, serverUrl: string): string =>
  `${serverUrl.replace(/\/+$/, "")}${path}?lang=${lang}`;

/** The privacy policy page in the app's language, on the given game server (by default the one the app plays on). */
export const privacyPolicyUrl = (lang: Lang, serverUrl: string = getEnvVars().SERVER_URL): string =>
  serverPageUrl(PRIVACY_PATH, lang, serverUrl);

/** The terms of use page in the app's language, on the given game server (by default the one the app plays on). */
export const termsOfUseUrl = (lang: Lang, serverUrl: string = getEnvVars().SERVER_URL): string =>
  serverPageUrl(TERMS_PATH, lang, serverUrl);

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
