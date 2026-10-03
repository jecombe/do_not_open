import type { Address, DuelStatus, TraitRoll } from "./types";

/** A box put up for a duel, and how far that duel went. */
export interface Duel {
  duelId: number;
  /** The challenger's box, the one on the shelf. */
  tokenA: number;
  /** The box that took it up, or the only one allowed to when `reserved`. Null while an open
   *  duel waits for a taker. */
  tokenB: number | null;
  reserved: boolean;
  challenger: Address | null;
  accepter: Address | null;
  status: DuelStatus;
  /** Unix seconds after which nobody can take it up. Null until the holding is proven. */
  openUntil: number | null;
  winner: number | null;
  loser: number | null;
  /** The trait the loser had to show. */
  shown: TraitRoll | null;
  createdBlock: number;
  updatedBlock: number;
  /** Log index of the last event applied, to order events of one block. */
  updatedLog: number;
  /** Unix seconds of the posting and of the last change, when known. */
  createdAt: number | null;
  updatedAt: number | null;
}

/** Statuses a duel never leaves. */
const FINAL: readonly DuelStatus[] = ["resolved", "cancelled", "void"];

/** Waiting for someone: its holding proof, a taker, or its outcome. */
export const OPEN_DUEL: readonly DuelStatus[] = ["posted", "open", "pending"];

export const isOpen = (d: Pick<Duel, "status">): boolean => OPEN_DUEL.includes(d.status);

/** On the shelf and still in time at `now` (unix seconds). */
export const onShelf = (d: Pick<Duel, "status" | "openUntil">, now: number): boolean => d.status === "open" && (d.openUntil === null || now <= d.openUntil);

/**
 * The boxes a duel on the shelf needs still sealed to be taken up: its own, and the one it is
 * reserved for. Once either is opened `acceptDuel` reverts, but nothing takes the listing down.
 */
export const shelfBoxes = (d: Pick<Duel, "tokenA" | "tokenB" | "reserved">): number[] => (d.reserved && d.tokenB !== null ? [d.tokenA, d.tokenB] : [d.tokenA]);

export const involves = (d: Pick<Duel, "tokenA" | "tokenB">, tokenId: number): boolean => d.tokenA === tokenId || d.tokenB === tokenId;

/**
 * Whether boxes `a` and `b` can settle `d` together: a duel between them under way, or one of
 * them up for a duel that the other may take up (open to all, or reserved for it).
 */
export function settles(d: Pick<Duel, "tokenA" | "tokenB" | "reserved" | "status" | "openUntil">, a: number, b: number, now: number): boolean {
  if (d.status === "pending") return (d.tokenA === a && d.tokenB === b) || (d.tokenA === b && d.tokenB === a);
  if (d.status !== "posted" && !onShelf(d, now)) return false;
  return (d.tokenA === a && (!d.reserved || d.tokenB === b)) || (d.tokenA === b && (!d.reserved || d.tokenB === a));
}

interface At {
  block: number;
  logIndex: number;
  timestamp: number | null;
}

export function post(input: { duelId: number; tokenA: number; tokenB: number | null; reserved: boolean; challenger: Address | null }, at: At): Duel {
  return {
    ...input,
    tokenB: input.reserved ? input.tokenB : null,
    accepter: null,
    status: "posted",
    openUntil: null,
    winner: null,
    loser: null,
    shown: null,
    createdBlock: at.block,
    updatedBlock: at.block,
    updatedLog: at.logIndex,
    createdAt: at.timestamp,
    updatedAt: at.timestamp,
  };
}

/**
 * Moves `d` to `status`, applying `patch`, if the event comes after the last one applied. A duel
 * can go back on the shelf, so order, not status, tells a late or replayed event: one that is not
 * newer is ignored, and so is anything after a final status. Projecting the same logs twice
 * changes nothing.
 */
export function advance(d: Duel, status: DuelStatus, at: At, patch: Partial<Pick<Duel, "tokenB" | "accepter" | "openUntil" | "winner" | "loser" | "shown">> = {}): Duel {
  if (FINAL.includes(d.status)) return d;
  if (at.block < d.updatedBlock || (at.block === d.updatedBlock && at.logIndex <= d.updatedLog)) return d;
  return { ...d, ...patch, status, updatedBlock: at.block, updatedLog: at.logIndex, updatedAt: at.timestamp ?? d.updatedAt };
}

export const open = (d: Duel, openUntil: number, at: At): Duel => advance(d, "open", at, { openUntil });
export const accept = (d: Duel, tokenB: number, accepter: Address, at: At): Duel => advance(d, "pending", at, { tokenB, accepter });
/** The taker did not hold their box: back on the shelf, as it was before. */
export const reopen = (d: Duel, at: At): Duel => advance(d, "open", at, { accepter: null, tokenB: d.reserved ? d.tokenB : null });
export const cancel = (d: Duel, at: At): Duel => advance(d, "cancelled", at);
export const voidDuel = (d: Duel, at: At): Duel => advance(d, "void", at);
export const resolve = (d: Duel, r: { winner: number; loser: number; shown: TraitRoll }, at: At): Duel => advance(d, "resolved", at, r);
