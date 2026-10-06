import type { Locale } from "./i18n/locale";

/** The site's canonical origin: every absolute URL (canonical, hreflang, Open Graph, JSON-LD) starts here. */
export const SITE_URL = "https://do-not-open.app";

/** The home page in a language: English at the root, the others under their prefix. */
export const homePath = (locale: Locale): string => (locale === "en" ? "/" : `/${locale}/`);

/** The manual in a language. */
export const docsPath = (locale: Locale): string => (locale === "en" ? "/docs" : `/${locale}/docs`);

/** The studio, where anyone draws a cat. */
export const studioPath = (locale: Locale): string => (locale === "en" ? "/studio" : `/${locale}/studio`);

/** The boarding page: Sign in with X, the tasks on X, the mainnet list. */
export const applyPath = (locale: Locale): string => (locale === "en" ? "/apply" : `/${locale}/apply`);

/** The game: one page for every language, which it reads from `?lang=`. */
export const appPath = (locale: Locale): string => (locale === "en" ? "/app" : `/app?lang=${locale}`);

/** The game opened on one of its views, with more of the query after it. */
const appViewPath = (locale: Locale, query: string): string => `${appPath(locale)}${locale === "en" ? "?" : "&"}${query}`;

/** The game opened on its flea market. */
export const marketPath = (locale: Locale): string => appViewPath(locale, "view=market");

/** The game opened on the duel ranking, where the mainnet allow list is claimed. */
export const duelRankingPath = (locale: Locale): string => appViewPath(locale, "view=leaderboard&board=duels");

/** The pages served once per language, as their path names them (prefix removed). */
export type LocalizedPage = "home" | "docs" | "studio" | "apply";

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
  if (rest === "/studio" || rest === "/studio.html") return "studio";
  if (rest === "/apply" || rest === "/apply.html") return "apply";
  return null;
}

export const pagePath = (page: LocalizedPage, locale: Locale): string =>
  page === "home" ? homePath(locale) : page === "docs" ? docsPath(locale) : page === "studio" ? studioPath(locale) : applyPath(locale);
