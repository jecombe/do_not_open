import type { Address } from "./types";

/**
 * Someone who used the protocol. A user exists from their first public act on-chain (a mint, a
 * shake, an opening...) or from signing in, whichever comes first.
 */
export interface User {
  address: Address;
  firstBlock: number | null;
  lastBlock: number | null;
  /** Unix seconds. */
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  /** Public acts seen on-chain. */
  actions: number;
  /** Set once they signed in with their wallet. */
  registeredAt: number | null;
  lastLoginAt: number | null;
}

/** Folds one more on-chain act into the user, created if new. */
export function seen(user: User | null, address: Address, at: { block: number; timestamp: number | null }): User {
  const u = user ?? { address, firstBlock: null, lastBlock: null, firstSeenAt: null, lastSeenAt: null, actions: 0, registeredAt: null, lastLoginAt: null };
  return {
    ...u,
    firstBlock: u.firstBlock === null ? at.block : Math.min(u.firstBlock, at.block),
    lastBlock: u.lastBlock === null ? at.block : Math.max(u.lastBlock, at.block),
    firstSeenAt: u.firstSeenAt ?? at.timestamp,
    lastSeenAt: at.timestamp !== null && (u.lastSeenAt === null || at.timestamp > u.lastSeenAt) ? at.timestamp : u.lastSeenAt,
    actions: u.actions + 1,
  };
}

export function loggedIn(user: User | null, address: Address, now: number): User {
  const u = user ?? { address, firstBlock: null, lastBlock: null, firstSeenAt: null, lastSeenAt: null, actions: 0, registeredAt: null, lastLoginAt: null };
  return { ...u, registeredAt: u.registeredAt ?? now, lastLoginAt: now };
}
