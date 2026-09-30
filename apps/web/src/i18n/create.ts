import { useCallback } from "react";
import { getLocale, useLocale, type Locale } from "./locale";

type Vars = Record<string, string | number>;

/** `shelf.mint` for a dictionary holding `shelf.mint_one` and `shelf.mint_other`. */
type PluralBase<K> = K extends `${infer B}_one` ? B : never;

const rules = new Map<Locale, Intl.PluralRules>();
const pluralRules = (locale: Locale) => {
  let r = rules.get(locale);
  if (!r) rules.set(locale, (r = new Intl.PluralRules(locale)));
  return r;
};

/**
 * A dictionary per locale, English as the reference: every other locale must hold
 * exactly its keys, which the types enforce. Messages take `{name}` placeholders;
 * a `count` variable picks the `_one` / `_other` form of a key.
 */
export function createI18n<D extends Record<string, string>>(dicts: Record<Locale, D>) {
  type Key = (keyof D & string) | PluralBase<keyof D & string>;

  /** Untyped lookup for keys built at runtime, such as trait names. `undefined` when no locale has it. */
  function lookup(key: string, locale: Locale = getLocale()): string | undefined {
    return dicts[locale][key] ?? dicts.en[key];
  }

  function format(message: string, vars: Vars | undefined, locale: Locale): string {
    if (!vars) return message;
    return message.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const v = vars[name];
      if (v === undefined) return whole;
      return typeof v === "number" ? v.toLocaleString(locale) : v;
    });
  }

  function translate(key: Key, vars: Vars | undefined, locale: Locale): string {
    let message = lookup(key, locale);
    if (typeof vars?.count === "number") {
      const category = pluralRules(locale).select(vars.count);
      message = lookup(`${key}_${category}`, locale) ?? lookup(`${key}_other`, locale) ?? message;
    }
    if (message === undefined) {
      console.warn(`[i18n] no message for "${key}"`);
      return key;
    }
    return format(message, vars, locale);
  }

  /** For code outside React: reads the locale at call time. */
  const t = (key: Key, vars?: Vars): string => translate(key, vars, getLocale());

  /** For components: the same, and the component re-renders when the language changes. */
  function useT() {
    const locale = useLocale();
    return useCallback((key: Key, vars?: Vars) => translate(key, vars, locale), [locale]);
  }

  return { t, useT, lookup };
}

export type Translate<K extends string> = (key: K, vars?: Vars) => string;
