import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ActionOptions, Address, ChainAdapter } from "@dno/chain-adapter";
import { useChain } from "./ChainProvider";

/** The two sealed balances a player holds: cUSDC to pay, cCROQ to feed. */
export type SealedToken = "cusdc" | "ccroq";

/** A sealed balance as last decrypted, with the ciphertext handle it was decrypted from. */
export interface Shielded {
  value: bigint;
  handle: string;
  /** When it was decrypted, in ms since the epoch. */
  at: number;
}

// Decrypting costs a signature, so the answer is kept in this browser and shown again on the
// next visit. One entry per contract and account, like the shakes in feltCache. It stays right
// as long as the balance's handle on chain is the one it came from: any transfer makes a new one.
const key = (token: SealedToken, contract: string, account: string) => `dno:${token}:${contract.toLowerCase()}:${account.toLowerCase()}`;
const handleOf = (adapter: ChainAdapter, token: SealedToken, account: Address) =>
  token === "cusdc" ? adapter.confidentialUsdcHandle(account) : adapter.confidentialCroqHandle(account);
const decrypt = (adapter: ChainAdapter, token: SealedToken, opts?: ActionOptions) =>
  token === "cusdc" ? adapter.confidentialUsdcBalance(opts) : adapter.confidentialBalance(opts);

const listeners = new Set<() => void>();
let version = 0;
/** The handle last read on chain for each token and account: shared, so every view agrees on staleness. */
const onChain = new Map<string, string>();

function notify(): void {
  version++;
  for (const l of listeners) l();
}

function recall(k: string): Shielded | null {
  try {
    const raw = JSON.parse(localStorage.getItem(k) ?? "null") as { value: string; handle: string; at: number } | null;
    return raw ? { value: BigInt(raw.value), handle: raw.handle, at: raw.at } : null;
  } catch {
    return null;
  }
}

function remember(k: string, s: Shielded): void {
  try {
    localStorage.setItem(k, JSON.stringify({ value: s.value.toString(), handle: s.handle, at: s.at }));
  } catch {
    // Private windows may refuse storage: the value still shows until the page closes.
    fallback.set(k, s);
  }
  notify();
}
const fallback = new Map<string, Shielded>();

/** Reads the balance's handle again, to tell whether the decrypted value still holds. */
async function check(adapter: ChainAdapter, token: SealedToken, account: Address): Promise<void> {
  const handle = await handleOf(adapter, token, account);
  const at = `${token}:${account.toLowerCase()}`;
  if (onChain.get(at) === handle) return;
  onChain.set(at, handle);
  notify();
}

/** The connected account's cUSDC balance as it was last decrypted: see `useSealed`. */
export function useShielded(watch?: unknown) {
  return useSealed("cusdc", watch);
}

/**
 * The connected account's sealed balance of `token` as it was last decrypted, anywhere on the site.
 * `stale` once the balance moved on chain since. `refresh` re-reads the handle (free),
 * `reveal` decrypts again (one signature) and keeps the answer.
 * The handle is read again whenever `watch` changes: pass a parent's running action.
 */
export function useSealed(token: SealedToken, watch?: unknown) {
  const { adapter, account, collection } = useChain();
  const contract = collection?.address;
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );

  const refresh = useCallback(() => {
    if (account) void check(adapter, token, account).catch(() => undefined);
  }, [adapter, token, account]);
  useEffect(refresh, [refresh, watch]);

  const reveal = useCallback(
    async (opts?: ActionOptions): Promise<bigint> => {
      if (!account || !contract) throw new Error("No account connected.");
      // The handle first: if a transfer lands in between, the value is only marked stale for nothing.
      const handle = await handleOf(adapter, token, account);
      const value = await decrypt(adapter, token, opts);
      onChain.set(`${token}:${account.toLowerCase()}`, handle);
      remember(key(token, contract, account), { value, handle, at: Date.now() });
      return value;
    },
    [adapter, token, account, contract],
  );

  const k = account && contract ? key(token, contract, account) : null;
  const known = k ? (fallback.get(k) ?? recall(k)) : null;
  const current = account ? onChain.get(`${token}:${account.toLowerCase()}`) : undefined;
  const stale = !!known && current !== undefined && current !== known.handle;
  return { known, stale, refresh, reveal };
}
