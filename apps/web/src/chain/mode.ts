import type { ChainMode } from "@dno/chain-adapter";

/** Modes announced in `.env.example` that no adapter implements yet. */
const PLANNED_MODES = ["mainnet", "solana-devnet", "solana-mainnet"];

/** Hosts that run the mock whatever the build says: one deployment can serve a demo domain next to the live one. */
const MOCK_HOSTS = (import.meta.env.VITE_MOCK_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

/** `?chain=mock` or `?chain=sepolia` in the URL wins over the host, which wins over the build-time setting. */
export function chainMode(): { mode: ChainMode; unavailable: string | null } {
  const byHost = MOCK_HOSTS.includes(window.location.hostname) ? "mock" : undefined;
  const wanted = new URLSearchParams(window.location.search).get("chain") ?? byHost ?? import.meta.env.VITE_CHAIN_MODE ?? "mock";
  if (wanted === "sepolia") return { mode: "sepolia", unavailable: null };
  if (PLANNED_MODES.includes(wanted)) return { mode: "mock", unavailable: wanted };
  if (wanted !== "mock") console.warn(`[chain] unknown VITE_CHAIN_MODE "${wanted}", running the mock`);
  return { mode: "mock", unavailable: null };
}

/** The network the visitor asked for, built or not: a planned mainnet still reads as mainnet. Null in the demo. */
export function chosenNetwork(): "sepolia" | "mainnet" | null {
  const { mode, unavailable } = chainMode();
  if (unavailable === "mainnet") return "mainnet";
  return mode === "sepolia" ? "sepolia" : null;
}

/** Reloads the page on another network: the adapter, the account and every read belong to one chain. */
export function switchNetwork(network: "sepolia" | "mainnet"): void {
  const url = new URL(window.location.href);
  url.searchParams.set("chain", network);
  window.location.assign(url.toString());
}
