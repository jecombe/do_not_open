import { siteHost, type SiteDomain } from "./hosts";

/**
 * The API this page talks to. The testnet site (its bare domain, `game.` and `vault.`) has its own
 * (its own index, boarding passes and allow list, so tests never reach the mainnet list); every
 * other host uses VITE_API_URL. One build serves both sites.
 */
const OWN_API: Partial<Record<SiteDomain, string>> = {
  "testnet.do-not-open.app": "https://api.testnet.do-not-open.app",
};

export function apiUrl(): string | null {
  const domain = siteHost(typeof location === "undefined" ? undefined : location.hostname)?.domain;
  const own = domain ? OWN_API[domain] : undefined;
  return (own ?? import.meta.env.VITE_API_URL)?.replace(/\/$/, "") || null;
}
