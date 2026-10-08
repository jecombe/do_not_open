import { partOrigin, siteHost, type HostPart, type SiteHost } from "./hosts";
import type { Locale } from "./i18n/locale";

/** The site's canonical origin: every absolute URL (canonical, hreflang, Open Graph, JSON-LD) starts here. */
export const SITE_URL = "https://do-not-open.app";

/** The pages served once per language, as their path names them (prefix removed). */
export type LocalizedPage = "home" | "project" | "docs" | "vaultDocs" | "studio" | "apply";

/** Which part of the site each page belongs to: the game's manual on `game.`, the vault's docs on `vault.`. */
const PART: Record<LocalizedPage, HostPart> = { home: "site", project: "site", docs: "game", vaultDocs: "vault", studio: "site", apply: "site" };

/**
 * A page's path after its language prefix. On the site's domains every part has its docs at
 * `/docs`; anywhere else (localhost, a preview) they share one host, so two of them take another
 * name, which is also the file the build writes (hosts.ts rewrites `/docs` to it).
 */
const REST = (page: LocalizedPage, split: boolean): string =>
  ({ home: "", project: split ? "/docs" : "/project", docs: "/docs", vaultDocs: split ? "/docs" : "/vault-docs", studio: "/studio", apply: "/apply" })[page];

const prefixed = (locale: Locale, rest: string): string => (locale === "en" ? rest || "/" : `/${locale}${rest || "/"}`);

/** The host this page runs on, when it is one of the site's domains. Null while prerendering. */
const here = (): SiteHost | null => siteHost(typeof location === "undefined" ? undefined : location.hostname);

/** A link to `path` on `part`: relative on that part's own host (or off the site's domains), absolute otherwise. */
function on(part: HostPart, path: string): string {
  const h = here();
  return !h || h.part === part ? path : `${partOrigin(h.domain, part)}${path}`;
}

/** A page's path on its own host, in a language: what the address bar shows there. */
export const pagePath = (page: LocalizedPage, locale: Locale): string => prefixed(locale, REST(page, here() !== null));

/** A link to a page from wherever this page runs. */
const link = (page: LocalizedPage, locale: Locale): string => on(PART[page], pagePath(page, locale));

/** A page's address on the live site, for canonical links, hreflang and Open Graph. */
export const canonicalUrl = (page: LocalizedPage, locale: Locale): string =>
  `${partOrigin("do-not-open.app", PART[page])}${prefixed(locale, REST(page, true))}`;

/** The home page, the project's front door. */
export const homePath = (locale: Locale): string => link("home", locale);

/** The project's documentation: what DO NOT OPEN is, what stays secret, the vault and the game. */
export const projectDocsPath = (locale: Locale): string => link("project", locale);

/** The game's manual. */
export const docsPath = (locale: Locale): string => link("docs", locale);

/** The sealed vault's documentation. */
export const vaultDocsPath = (locale: Locale): string => link("vaultDocs", locale);

/** The studio, where anyone draws a cat. */
export const studioPath = (locale: Locale): string => link("studio", locale);

/** The boarding page: Sign in with X, the tasks on X, the mainnet list. */
export const applyPath = (locale: Locale): string => link("apply", locale);

const lang = (locale: Locale): string => (locale === "en" ? "" : `?lang=${locale}`);

/** The sealed vault: one page for every language, which it reads from `?lang=`, as the game does. */
export const vaultPath = (locale: Locale): string => (here() ? on("vault", "/") : "/vault") + lang(locale);

/** The game: one page for every language, which it reads from `?lang=`. */
export const appPath = (locale: Locale): string => (here() ? on("game", "/") : "/app") + lang(locale);

/** The game opened on one of its views, with more of the query after it. */
const appViewPath = (locale: Locale, query: string): string => `${appPath(locale)}${locale === "en" ? "?" : "&"}${query}`;

/** The game opened on its flea market. */
export const marketPath = (locale: Locale): string => appViewPath(locale, "view=market");

/** The game opened on the duel ranking, where the mainnet allow list is claimed. */
export const duelRankingPath = (locale: Locale): string => appViewPath(locale, "view=leaderboard&board=duels");

const PREFIX = /^\/(fr|es|it)(?=\/|$)/;

/** The locale a path is prefixed with (`/fr/docs` → fr), or null for an English or unlocalized path. */
export function pathLocale(pathname: string): Locale | null {
  return (PREFIX.exec(pathname)?.[1] as Locale | undefined) ?? null;
}

/**
 * Which localized page a path shows on this host, or null for a page that keeps one URL in every
 * language (the game, the vault). `/docs` is the docs of the part it is asked on.
 */
export function localizedPage(pathname: string): LocalizedPage | null {
  const rest = pathname.replace(PREFIX, "").replace(/\/+$/, "") || "/";
  const h = here();
  if (rest === "/" || rest === "/index.html" || rest === "/index") return h && h.part !== "site" ? null : "home";
  if (rest === "/docs" || rest === "/docs.html") return h?.part === "site" ? "project" : h?.part === "vault" ? "vaultDocs" : "docs";
  if (rest === "/project" || rest === "/project.html") return "project";
  if (rest === "/vault-docs" || rest === "/vault-docs.html") return "vaultDocs";
  if (rest === "/studio" || rest === "/studio.html") return "studio";
  if (rest === "/apply" || rest === "/apply.html") return "apply";
  return null;
}
