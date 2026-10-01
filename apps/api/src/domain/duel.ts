import type { Address, DuelStatus, TraitRoll } from "./types";

export interface Duel {
  duelId: number;
  tokenA: number;
  tokenB: number;
  /** Who challenged. Read from the contract: the log does not name them. */
  challenger: Address | null;
  accepter: Address | null;
  status: DuelStatus;
  winner: number | null;
  loser: number | null;
  /** The trait the loser had to show. */
  shown: TraitRoll | null;
  createdBlock: number;
  updatedBlock: number;
  /** Unix seconds of the challenge and of the last change, when known. */
  createdAt: number | null;
  updatedAt: number | null;
}

/**
 * How far along a duel is. A duel only moves forward: an event that would move it back is a
 * replay or arrived late, and is ignored, so projecting the same logs twice changes nothing.
 */
const RANK: Record<DuelStatus, number> = { challenged: 0, pending: 1, resolved: 2, cancelled: 2, void: 2 };

export const OPEN_DUEL: readonly DuelStatus[] = ["challenged", "pending"];

export const isOpen = (d: Pick<Duel, "status">): boolean => OPEN_DUEL.includes(d.status);

export const involves = (d: Pick<Duel, "tokenA" | "tokenB">, tokenId: number): boolean => d.tokenA === tokenId || d.tokenB === tokenId;

export const between = (d: Pick<Duel, "tokenA" | "tokenB">, a: number, b: number): boolean =>
  (d.tokenA === a && d.tokenB === b) || (d.tokenA === b && d.tokenB === a);

interface At {
  block: number;
  timestamp: number | null;
}

export function challenge(input: { duelId: number; tokenA: number; tokenB: number; challenger: Address | null }, at: At): Duel {
  return {
    ...input,
    accepter: null,
    status: "challenged",
    winner: null,
    loser: null,
    shown: null,
    createdBlock: at.block,
    updatedBlock: at.block,
    createdAt: at.timestamp,
    updatedAt: at.timestamp,
  };
}

/** Moves `d` to `status` if that is forward, applying `patch`. Returns `d` untouched otherwise. */
export function advance(d: Duel, status: DuelStatus, at: At, patch: Partial<Pick<Duel, "accepter" | "winner" | "loser" | "shown">> = {}): Duel {
  if (RANK[status] <= RANK[d.status]) return d;
  return { ...d, ...patch, status, updatedBlock: at.block, updatedAt: at.timestamp ?? d.updatedAt };
}

export const accept = (d: Duel, accepter: Address | null, at: At): Duel => advance(d, "pending", at, { accepter: accepter ?? d.accepter });
export const cancel = (d: Duel, at: At): Duel => advance(d, "cancelled", at);
export const voidDuel = (d: Duel, at: At): Duel => advance(d, "void", at);
export const resolve = (d: Duel, r: { winner: number; loser: number; shown: TraitRoll }, at: At): Duel => advance(d, "resolved", at, r);
