import type { DuelInfo } from "./types";

type DuelShape = Pick<DuelInfo, "tokenA" | "tokenB" | "reserved" | "status" | "openUntil">;

/** Whether `d` can still be taken up at `nowSeconds`: proven, and not out of time. */
export function onShelf(d: DuelShape, nowSeconds = Date.now() / 1000): boolean {
  return d.status === "open" && (d.openUntil === null || nowSeconds <= d.openUntil);
}

/**
 * The boxes a duel on the shelf needs still sealed to be taken up: its own, and the one it is
 * reserved for. Once either is opened `acceptDuel` reverts, but nothing takes the listing down.
 */
export function shelfBoxes(d: Pick<DuelInfo, "tokenA" | "tokenB" | "reserved">): number[] {
  return d.reserved && d.tokenB !== null ? [d.tokenA, d.tokenB] : [d.tokenA];
}

/** Whether a duel is still waiting for someone: its proof, a taker, or its outcome. */
export function duelUnderway(d: DuelShape, nowSeconds = Date.now() / 1000): boolean {
  return d.status === "posted" || d.status === "pending" || onShelf(d, nowSeconds);
}

/**
 * Whether boxes `a` and `b` can settle duel `d` together: a duel between them under way, or one
 * of them up for a duel (posted or on the shelf) that the other may take up.
 */
export function duelSettles(d: DuelShape, a: number, b: number, nowSeconds = Date.now() / 1000): boolean {
  if (d.status === "pending") return (d.tokenA === a && d.tokenB === b) || (d.tokenA === b && d.tokenB === a);
  if (d.status !== "posted" && !onShelf(d, nowSeconds)) return false;
  return (d.tokenA === a && (!d.reserved || d.tokenB === b)) || (d.tokenA === b && (!d.reserved || d.tokenB === a));
}
