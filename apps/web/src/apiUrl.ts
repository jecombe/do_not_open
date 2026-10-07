/**
 * The API this page talks to. The testnet site has its own (its own index, boarding passes and
 * allow list, so tests never reach the mainnet list); every other host uses VITE_API_URL. One
 * build serves both sites.
 */
const OWN_API: Record<string, string> = {
  "testnet.do-not-open.app": "https://api.testnet.do-not-open.app",
};

export function apiUrl(): string | null {
  const own = typeof location === "undefined" ? undefined : OWN_API[location.hostname];
  return (own ?? import.meta.env.VITE_API_URL)?.replace(/\/$/, "") || null;
}
