import type { TraitRoll } from "@dno/chain-adapter";

/** How long a shake's answer stays on the box for whoever shook it. */
export const FELT_TTL_MS = 24 * 60 * 60 * 1000;

export interface Felt extends TraitRoll {
  /** When it was felt, in ms since the epoch. */
  at: number;
}

type Store = Record<string, Felt[]>;

// A shake is readable by the shaker alone, so its answer is kept in their browser only:
// one entry per contract and account, so another wallet or another deployment starts empty.
const key = (contract: string, account: string) => `dno:felt:${contract.toLowerCase()}:${account.toLowerCase()}`;

function read(k: string): Store {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "{}") as Store;
  } catch {
    return {};
  }
}

/** Drops what is older than the TTL, and keeps only the latest roll of each trait. */
function fresh(list: Felt[], now: number): Felt[] {
  const latest = new Map<number, Felt>();
  for (const f of list) {
    if (now - f.at >= FELT_TTL_MS) continue;
    const seen = latest.get(f.traitIndex);
    if (!seen || seen.at < f.at) latest.set(f.traitIndex, f);
  }
  return [...latest.values()].sort((a, b) => b.at - a.at);
}

/** What `account` felt in this box over the last 24 hours, newest first. */
export function recallFelt(contract: string, account: string, tokenId: number, now = Date.now()): Felt[] {
  return fresh(read(key(contract, account))[tokenId] ?? [], now);
}

/** Keeps a shake's answer, and clears out anything that has expired meanwhile. */
export function rememberFelt(contract: string, account: string, tokenId: number, roll: TraitRoll, now = Date.now()): Felt[] {
  const k = key(contract, account);
  const store = read(k);
  const next: Store = {};
  for (const [id, list] of Object.entries(store)) {
    const kept = fresh(list, now);
    if (kept.length) next[id] = kept;
  }
  next[tokenId] = fresh([{ ...roll, at: now }, ...(next[tokenId] ?? [])], now);
  try {
    localStorage.setItem(k, JSON.stringify(next));
  } catch {
    // Private windows may refuse storage: the answer still shows until the page closes.
  }
  return next[tokenId];
}
