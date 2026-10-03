import type { Locale } from "./i18n/locale";

/** The site's canonical origin: every absolute URL (canonical, hreflang, Open Graph, JSON-LD) starts here. */
export const SITE_URL = "https://do-not-open.app";

/** The home page in a language: English at the root, the others under their prefix. */
export const homePath = (locale: Locale): string => (locale === "en" ? "/" : `/${locale}/`);

/** The manual in a language. */
export const docsPath = (locale: Locale): string => (locale === "en" ? "/docs" : `/${locale}/docs`);

/** The game: one page for every language, which it reads from `?lang=`. */
export const appPath = (locale: Locale): string => (locale === "en" ? "/app" : `/app?lang=${locale}`);

/** The pages served once per language, as their path names them (prefix removed). */
export type LocalizedPage = "home" | "docs";

const PREFIX = /^\/(fr|es|it)(?=\/|$)/;

/** The locale a path is prefixed with (`/fr/docs` → fr), or null for an English or unlocalized path. */
export function pathLocale(pathname: string): Locale | null {
  return (PREFIX.exec(pathname)?.[1] as Locale | undefined) ?? null;
}

/** Which localized page a path shows, or null for a page that keeps one URL in every language (the game). */
export function localizedPage(pathname: string): LocalizedPage | null {
  const rest = pathname.replace(PREFIX, "").replace(/\/+$/, "") || "/";
  if (rest === "/" || rest === "/index.html" || rest === "/index") return "home";
  if (rest === "/docs" || rest === "/docs.html") return "docs";
  return null;
}

export const pagePath = (page: LocalizedPage, locale: Locale): string => (page === "home" ? homePath(locale) : docsPath(locale));
