import { LOCALE_NAMES, LOCALES, setLocale, useLocale } from "./locale";

/** Four small tags, one per language. The current one is stamped. */
export function LangSwitch({ label }: { label: string }) {
  const locale = useLocale();
  return (
    <div className="lang" role="group" aria-label={label}>
      {LOCALES.map((l) => (
        <button type="button" key={l} lang={l} aria-pressed={l === locale} title={LOCALE_NAMES[l]} onClick={() => setLocale(l)}>
          {l}
        </button>
      ))}
    </div>
  );
}
