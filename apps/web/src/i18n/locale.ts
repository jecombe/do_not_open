import { useSyncExternalStore } from "react";

export type Locale = "en" | "fr" | "es" | "it";

export const LOCALES: readonly Locale[] = ["en", "fr", "es", "it"];
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", fr: "Français", es: "Español", it: "Italiano" };

const STORAGE_KEY = "dno.lang";
const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** `?lang=fr` wins, then what the visitor picked last time, then the browser's languages. */
function detect(): Locale {
  if (typeof window === "undefined") return "en";
  const fromUrl = new URLSearchParams(window.location.search).get("lang");
  if (isLocale(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Private mode or blocked storage: fall through to the browser's languages.
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const short = tag.slice(0, 2).toLowerCase();
    if (isLocale(short)) return short;
  }
  return "en";
}

let current: Locale = detect();
const listeners = new Set<() => void>();

if (typeof document !== "undefined") document.documentElement.lang = current;

export const getLocale = (): Locale => current;

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  document.documentElement.lang = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Nothing to do: the choice lives for this page only.
  }
  // Keep the address shareable in the chosen language, without reloading.
  const url = new URL(window.location.href);
  url.searchParams.set("lang", next);
  window.history.replaceState(window.history.state, "", url);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The current locale, re-rendering the component when it changes. */
export const useLocale = (): Locale => useSyncExternalStore(subscribe, getLocale, () => "en");
