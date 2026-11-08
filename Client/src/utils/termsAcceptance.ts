import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Terms of use acceptance (EXP-433, DEC-058) ──
// Players accept the terms of use (the server's /terms page) on the first screen before they share anything. The
// device remembers which version it accepted: bump TERMS_VERSION when what the terms say changes (with the server's
// TERMS_LAST_UPDATED, Server/routes/termsPage.ts: Server/tests/termsPage.test.ts checks they match) and every device
// shows the first screen again, once.

/** Version of the terms the first screen asks to accept: the date of their last change */
export const TERMS_VERSION = "2026-11-08";

/** Storage key of the accepted terms version (replaces the old "hasSeenInitialScreen" flag, which predates the terms) */
export const ACCEPTED_TERMS_KEY = "acceptedTermsVersion";

/** Whether this device accepted the current terms (false when it never did, or accepted an older version). */
export const hasAcceptedCurrentTerms = async (): Promise<boolean> =>
  (await AsyncStorage.getItem(ACCEPTED_TERMS_KEY)) === TERMS_VERSION;

/** Remembers that this device accepted the current terms. */
export const recordTermsAccepted = (): Promise<void> => AsyncStorage.setItem(ACCEPTED_TERMS_KEY, TERMS_VERSION);
