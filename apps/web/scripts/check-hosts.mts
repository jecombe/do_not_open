/**
 * Checks the site's routing by host (src/hosts/index.ts, what the edge middleware does) and the links
 * the pages build from each host (src/site.ts). Part of `pnpm --filter @dno/web test`.
 */
import assert from "node:assert/strict";
import { hostRoute, siteHost } from "../src/hosts";

const route = (url: string) => hostRoute(new URL(url));

// Hosts.
assert.deepEqual(siteHost("do-not-open.app"), { domain: "do-not-open.app", part: "site" });
assert.deepEqual(siteHost("www.do-not-open.app"), { domain: "do-not-open.app", part: "site" });
assert.deepEqual(siteHost("game.testnet.do-not-open.app"), { domain: "testnet.do-not-open.app", part: "game" });
assert.deepEqual(siteHost("vault.do-not-open.app"), { domain: "do-not-open.app", part: "vault" });
assert.deepEqual(siteHost("testnet.do-not-open.app"), { domain: "testnet.do-not-open.app", part: "site" });
assert.equal(siteHost("localhost"), null);
assert.equal(siteHost("do-not-open-abc.vercel.app"), null);

// The bare domain: its pages stay, the game and the vault move to their subdomains, query kept.
assert.equal(route("https://do-not-open.app/"), null);
assert.equal(route("https://do-not-open.app/apply?ref=abc"), null);
assert.deepEqual(route("https://do-not-open.app/app?box=12&chain=sepolia"), { redirect: "https://game.do-not-open.app/?box=12&chain=sepolia" });
assert.deepEqual(route("https://testnet.do-not-open.app/app"), { redirect: "https://game.testnet.do-not-open.app/" });
assert.deepEqual(route("https://testnet.do-not-open.app/fr/app/"), { redirect: "https://game.testnet.do-not-open.app/?lang=fr" });
assert.deepEqual(route("https://do-not-open.app/vault?lang=it"), { redirect: "https://vault.do-not-open.app/?lang=it" });
assert.deepEqual(route("https://do-not-open.app/docs"), { rewrite: "/project" });
assert.deepEqual(route("https://do-not-open.app/es/docs"), { rewrite: "/es/project" });

// game.: the game at the root, the manual at /docs, the rest back to the bare domain.
assert.deepEqual(route("https://game.do-not-open.app/"), { rewrite: "/app" });
assert.deepEqual(route("https://game.do-not-open.app/?box=3&lang=fr"), { rewrite: "/app?box=3&lang=fr" });
assert.equal(route("https://game.do-not-open.app/docs"), null);
assert.equal(route("https://game.do-not-open.app/fr/docs"), null);
assert.deepEqual(route("https://game.do-not-open.app/app?box=3"), { redirect: "/?box=3" });
assert.deepEqual(route("https://game.testnet.do-not-open.app/vault"), { redirect: "https://vault.testnet.do-not-open.app/" });
assert.deepEqual(route("https://game.do-not-open.app/apply"), { redirect: "https://do-not-open.app/apply" });
assert.deepEqual(route("https://game.do-not-open.app/fr/"), { redirect: "https://do-not-open.app/fr/" });
assert.equal(route("https://game.do-not-open.app/it/studio"), null);
assert.deepEqual(route("https://do-not-open.app/studio?x=1"), { redirect: "https://game.do-not-open.app/studio?x=1" });
assert.deepEqual(route("https://testnet.do-not-open.app/fr/studio"), { redirect: "https://game.testnet.do-not-open.app/fr/studio" });
assert.deepEqual(route("https://vault.do-not-open.app/studio"), { redirect: "https://game.do-not-open.app/studio" });

// vault.: the vault at the root, its docs at /docs.
assert.deepEqual(route("https://vault.testnet.do-not-open.app/"), { rewrite: "/vault" });
assert.deepEqual(route("https://vault.do-not-open.app/docs"), { rewrite: "/vault-docs" });
assert.deepEqual(route("https://vault.do-not-open.app/fr/docs"), { rewrite: "/fr/vault-docs" });
assert.deepEqual(route("https://vault.do-not-open.app/app"), { redirect: "https://game.do-not-open.app/" });

// Off the site's domains nothing moves.
assert.equal(route("http://localhost:5173/app"), null);
assert.equal(route("https://do-not-open-git-x.vercel.app/vault"), null);

// The links each host builds.
const at = async (href: string) => {
  Object.assign(globalThis, { location: new URL(href) });
  return import(`../src/site.ts?${encodeURIComponent(href)}`) as Promise<typeof import("../src/site.ts")>;
};

let site = await at("https://testnet.do-not-open.app/");
assert.equal(site.appPath("fr"), "https://game.testnet.do-not-open.app/?lang=fr");
assert.equal(site.vaultPath("en"), "https://vault.testnet.do-not-open.app/");
assert.equal(site.docsPath("fr"), "https://game.testnet.do-not-open.app/fr/docs");
assert.equal(site.projectDocsPath("en"), "/docs");
assert.equal(site.vaultDocsPath("es"), "https://vault.testnet.do-not-open.app/es/docs");
assert.equal(site.applyPath("fr"), "/fr/apply");
assert.equal(site.studioPath("fr"), "https://game.testnet.do-not-open.app/fr/studio");
assert.equal(site.localizedPage("/fr/docs"), "project");

site = await at("https://game.do-not-open.app/?lang=fr");
assert.equal(site.appPath("fr"), "/?lang=fr");
assert.equal(site.marketPath("en"), "/?view=market");
assert.equal(site.homePath("fr"), "https://do-not-open.app/fr/");
assert.equal(site.docsPath("fr"), "/fr/docs");
assert.equal(site.studioPath("es"), "/es/studio");
assert.equal(site.localizedPage("/"), null);
assert.equal(site.localizedPage("/docs"), "docs");
assert.equal(site.pagePath("docs", "it"), "/it/docs");

site = await at("https://vault.do-not-open.app/docs");
assert.equal(site.localizedPage("/docs"), "vaultDocs");
assert.equal(site.pagePath("vaultDocs", "fr"), "/fr/docs");
assert.equal(site.appPath("en"), "https://game.do-not-open.app/");

site = await at("http://localhost:5173/");
assert.equal(site.appPath("fr"), "/app?lang=fr");
assert.equal(site.vaultPath("en"), "/vault");
assert.equal(site.projectDocsPath("fr"), "/fr/project");
assert.equal(site.vaultDocsPath("en"), "/vault-docs");
assert.equal(site.docsPath("en"), "/docs");
assert.equal(site.localizedPage("/docs"), "docs");

assert.equal(site.canonicalUrl("vaultDocs", "fr"), "https://vault.do-not-open.app/fr/docs");
assert.equal(site.canonicalUrl("project", "en"), "https://do-not-open.app/docs");
assert.equal(site.canonicalUrl("home", "it"), "https://do-not-open.app/it/");
assert.equal(site.canonicalUrl("studio", "fr"), "https://game.do-not-open.app/fr/studio");

console.log("hosts: routes and links check out");
