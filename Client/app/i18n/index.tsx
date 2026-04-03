import React, { createContext, useContext, useState, useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import es from "./es";
import en from "./en";

type Lang = "es" | "en";
type Translations = typeof es;

const translations: Record<Lang, Translations> = { es, en };

interface I18nContextType {
  t: Translations;
  lang: Lang;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>("en");
  const [loaded, setLoaded] = useState(false);

  // Load saved language on mount
  React.useEffect(() => {
    AsyncStorage.getItem("app-lang").then((saved) => {
      if (saved === "en" || saved === "es") setLangState(saved);
      setLoaded(true);
    });
  }, []);

  const setLang = useCallback((newLang: Lang) => {
    setLangState(newLang);
    AsyncStorage.setItem("app-lang", newLang);
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
