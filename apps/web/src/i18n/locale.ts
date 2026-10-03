import { useSyncExternalStore } from "react";
import { localizedPage, pagePath, pathLocale } from "../site";

export type Locale = "en" | "fr" | "es" | "it";

export const LOCALES: readonly Locale[] = ["en", "fr", "es", "it"];
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", fr: "Français", es: "Español", it: "Italiano" };

const STORAGE_KEY = "dno.lang";
const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/**
 * The language in the path wins (`/fr/docs`), then `?lang=fr`, then what the visitor picked
 * last time, then the browser's languages. An English page at the root (`/`, `/docs`) has no
 * prefix, so a visitor who reads French still gets French there.
 */
function detect(): Locale {
  if (typeof window === "undefined") return "en";
  const fromPath = pathLocale(window.location.pathname ?? "/");
  if (fromPath) return fromPath;
  const fromUrl = new URLSearchParams(window.location.search).get("lang");
  if (isLocale(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Private mode or blocked storage: fall through to the browser's languages.
  }
  for (const tag of (typeof navigator !== "undefined" && (navigator.languages ?? [navigator.language])) || []) {
    const short = tag.slice(0, 2).toLowerCase();
    if (isLocale(short)) return short;
  }
  return "en";
}

/**
 * Keeps the address shareable in the language shown, without reloading. The home page and the
 * manual have one path per language (`/fr/docs`, `/docs` for English); the game keeps `?lang=`.
 */
function syncUrl(locale: Locale): void {
  if (typeof window === "undefined" || !window.location?.href || !window.history) return;
  const url = new URL(window.location.href);
  const page = localizedPage(url.pathname);
  if (page) {
    url.pathname = pagePath(page, locale);
    url.searchParams.delete("lang");
  } else url.searchParams.set("lang", locale);
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

let current: Locale = detect();
const listeners = new Set<() => void>();

if (typeof document !== "undefined") {
  document.documentElement.lang = current;
  // An old `docs.html?lang=fr` link, or a French reader landing on `/`: show the matching path.
  if (typeof window !== "undefined" && localizedPage(window.location.pathname ?? "/")) syncUrl(current);
}

export const getLocale = (): Locale => current;

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Nothing to do: the choice lives for this page only.
  }
  syncUrl(next);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The current locale, re-rendering the component when it changes. */
// Rendered outside a browser (the manual's export, the prerendered pages), it follows `setLocale` too.
export const useLocale = (): Locale => useSyncExternalStore(subscribe, getLocale, getLocale);
