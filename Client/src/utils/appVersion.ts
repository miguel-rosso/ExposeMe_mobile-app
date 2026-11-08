import Constants from "expo-constants";

// ── App version (EXP-434) ──

/**
 * The version players see in the stores (app.json "version", embedded in the build), or null when the build carries
 * no app config. The build number is not part of it: EAS keeps it remotely (eas.json appVersionSource "remote").
 */
export const appVersion = (): string | null => Constants.expoConfig?.version ?? null;
