import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ptBR from "@/locales/pt-BR.json";
import en from "@/locales/en.json";

const STORAGE_KEY = "jlm_lang";

function detectLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "pt-BR" || stored === "en") return stored;
  } catch { /* */ }
  const browser = navigator.language ?? "pt-BR";
  return browser.startsWith("pt") ? "pt-BR" : "en";
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      "pt-BR": { translation: ptBR },
      en: { translation: en },
    },
    lng: detectLanguage(),
    fallbackLng: "pt-BR",
    interpolation: { escapeValue: false },
  });

export function setLanguage(lang: "pt-BR" | "en") {
  i18n.changeLanguage(lang);
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* */ }
}

export { i18n };
