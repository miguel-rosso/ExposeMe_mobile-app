import { createContext } from "react";
import type es from "./es";

// The context lives apart from the translations and the provider: a Fast Refresh edit to es.ts, en.ts or index.tsx
// re-evaluates those modules but not this one, so the mounted provider and every useI18n keep sharing one context.
// Keep it that way: at runtime this file may import only react, and es must stay an `import type`.

export type Lang = "es" | "en";
// Every language must provide the same keys; values differ per language
export type Translations = { readonly [K in keyof typeof es]: string };

export interface I18nContextType {
  t: Translations;
  lang: Lang;
  setLang: (lang: Lang) => void;
}

export const I18nContext = createContext<I18nContextType | undefined>(undefined);
