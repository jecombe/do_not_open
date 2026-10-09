/**
 * The site's domains. Each network has three: the project's page at the bare domain, the sealed
 * vault on `vault.` and the game on `game.`, all served by one build. Anywhere else (localhost,
 * a Vercel preview) everything stays on one host under its path: `/vault`, `/app`.
 *
 * Read by the pages (site.ts, apiUrl.ts) and by the edge middleware (middleware.ts at the repo
 * root), so it touches no browser global and no `import.meta`. Its folder is CommonJS
 * (package.json): the middleware is compiled to CommonJS and require()s it.
 */

/** The bare domains, the testnet first: `game.testnet.do-not-open.app` must not match the mainnet's. */
export const SITE_DOMAINS = ["testnet.do-not-open.app", "do-not-open.app"] as const;
export type SiteDomain = (typeof SITE_DOMAINS)[number];

/** Which of the three a host serves. */
export type HostPart = "site" | "game" | "vault";

export interface SiteHost {
  domain: SiteDomain;
  part: HostPart;
}

/** The domain and part a host name belongs to, or null for a host outside them (localhost, a preview). */
export function siteHost(hostname: string | undefined | null): SiteHost | null {
  if (!hostname) return null;
  const host = hostname.toLowerCase();
  for (const domain of SITE_DOMAINS) {
    if (host === domain || host === `www.${domain}`) return { domain, part: "site" };
    if (host === `game.${domain}`) return { domain, part: "game" };
    if (host === `vault.${domain}`) return { domain, part: "vault" };
  }
  return null;
}

/** The origin of one part of a domain. */
export const partOrigin = (domain: SiteDomain, part: HostPart): string => `https://${part === "site" ? "" : `${part}.`}${domain}`;

/** What the edge does with a request: serve another page under the same URL, send the browser elsewhere, or nothing. */
export type HostRoute = { rewrite: string } | { redirect: string } | null;

/** The bare domain's own pages asked on a subdomain: its home in a language, the boarding page. */
const SITE_PAGE = /^(?:\/(?:fr|es|it))?(?:\/apply)?\/?$/;
/** The studio, where anyone draws a rat: part of the game, so on `game.`. */
const STUDIO_PATH = /^(?:\/(?:fr|es|it))?\/studio\/?$/;
/** The game and the vault under their old paths, in any language prefix (`/fr/app` is an old link too). */
const GAME_PATH = /^(?:\/(fr|es|it))?\/app(?:\.html)?\/?$/;
const VAULT_PATH = /^(?:\/(fr|es|it))?\/vault(?:\.html)?\/?$/;
/** Each part's documentation, at `/docs` on its own host (`/fr/docs` ...). */
const DOCS_PATH = /^(\/(?:fr|es|it))?\/docs\/?$/;
/** The file each part's `/docs` is built as: the game's manual is `docs.html` itself. */
const DOCS_FILE: Record<HostPart, string | null> = { site: "project", game: null, vault: "vault-docs" };

/** `search` with `lang` set when a language prefix gave one (and the query did not already). */
function withLang(search: string, lang: string | undefined): string {
  const q = new URLSearchParams(search);
  if (lang && !q.has("lang")) q.set("lang", lang);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Where a request goes, from its host and path. The game and the vault sit at the root of their
 * subdomains and each part has its documentation at `/docs` (rewrites: the address bar keeps the
 * path). Their old paths on the bare domain, and the bare domain's pages asked on a subdomain, are
 * redirected, query kept, so every old link works.
 */
export function hostRoute(url: URL): HostRoute {
  const host = siteHost(url.hostname);
  if (!host) return null;
  const { domain, part } = host;
  const path = url.pathname;
  const game = GAME_PATH.exec(path);
  const vault = VAULT_PATH.exec(path);
  const docs = DOCS_PATH.exec(path);

  if (game && part !== "game") return { redirect: `${partOrigin(domain, "game")}/${withLang(url.search, game[1])}` };
  if (vault && part !== "vault") return { redirect: `${partOrigin(domain, "vault")}/${withLang(url.search, vault[1])}` };
  if (STUDIO_PATH.test(path) && part !== "game") return { redirect: `${partOrigin(domain, "game")}${path}${url.search}` };
  if (docs) {
    const file = DOCS_FILE[part];
    return file ? { rewrite: `${docs[1] ?? ""}/${file}${url.search}` } : null;
  }
  if (part === "site") return null;

  // On game. or vault.: its own old path comes back to the root, the root shows the page.
  if (game || vault) return { redirect: `/${withLang(url.search, (game ?? vault)![1])}` };
  if (path === "/") return { rewrite: `/${part === "game" ? "app" : "vault"}${url.search}` };
  if (SITE_PAGE.test(path)) return { redirect: `${partOrigin(domain, "site")}${path}${url.search}` };
  return null;
}
