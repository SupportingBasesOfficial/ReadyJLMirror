import { useTranslation } from "react-i18next";
import { setLanguage } from "@/i18n";

export function LanguageToggle() {
  const { i18n } = useTranslation();
  const current = i18n.language === "en" ? "en" : "pt-BR";

  return (
    <button
      onClick={() => setLanguage(current === "pt-BR" ? "en" : "pt-BR")}
      title={current === "pt-BR" ? "Switch to English" : "Mudar para Português"}
      className="text-[11px] font-medium px-2 py-0.5 rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--brand,#6366f1)] transition-colors tabular-nums"
    >
      {current === "pt-BR" ? "EN" : "PT"}
    </button>
  );
}
