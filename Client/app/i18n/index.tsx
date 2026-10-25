import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import es from "./es";
import en from "./en";

type Lang = "es" | "en";
// Every language must provide the same keys; values differ per language
type Translations = { readonly [K in keyof typeof es]: string };

// `satisfies` also rejects keys that only one language defines
const translations = { es, en } satisfies Record<Lang, Translations>;

interface I18nContextType {
  t: Translations;
  lang: Lang;
  setLang: (lang: Lang) => void;
}

// ── Initial language ──
const STORAGE_KEY = "app-lang";

/** Device locale (e.g. "es-ES"); Hermes ships Intl on both platforms. */
export const getDeviceLocale = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
};

/** A saved user choice wins; otherwise Spanish devices (any es-*) get es, everyone else en. */
export const resolveInitialLang = (saved: string | null | undefined, deviceLocale: string | undefined): Lang => {
  if (saved === "en" || saved === "es") return saved;
  return deviceLocale?.toLowerCase().split(/[-_]/)[0] === "es" ? "es" : "en";
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>("en");
  const [loaded, setLoaded] = useState(false);

  // Load saved language on mount, falling back to the device language
  React.useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .catch(() => null)
      .then((saved) => {
        setLangState(resolveInitialLang(saved, getDeviceLocale()));
        setLoaded(true);
      });
  }, []);

  const setLang = useCallback((newLang: Lang) => {
    setLangState(newLang);
    AsyncStorage.setItem(STORAGE_KEY, newLang);
  }, []);

  const value = useMemo(() => ({
    t: translations[lang],
    lang,
    setLang,
  }), [lang, setLang]);

  if (!loaded) return null;

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = () => {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
};
