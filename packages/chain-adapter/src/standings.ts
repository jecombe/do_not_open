/**
 * Duel standings and the mainnet allow list. Pure, shared by the API, the mock and the app, so
 * that every reader ranks the same way. Nothing here touches who holds a box: a duel's winner
 * and loser are boxes, and the two players are the addresses the duel itself made public (the
 * challenger proved holding box A, the accepter box B, both at the outcome).
 */

import { spec } from "@dno/game-spec";

/** A settled duel, as public as it gets. */
export interface SettledDuel {
  tokenA: number;
  tokenB: number;
  challenger: string;
  accepter: string;
  winner: number;
  loser: number;
}

/** One box in the duel ranking. */
export interface DuelStanding {
  tokenId: number;
  wins: number;
  losses: number;
}

/** Boxes ranked by duels: the top ones wear a rosette. */
export const ROSETTES = 3;

/** Most wins first, then fewest losses, then the lower serial: it was there first. */
export function duelStandings(duels: readonly SettledDuel[]): DuelStanding[] {
  const by = new Map<number, DuelStanding>();
  const of = (tokenId: number) => by.get(tokenId) ?? by.set(tokenId, { tokenId, wins: 0, losses: 0 }).get(tokenId)!;
  for (const d of duels) {
    of(d.winner).wins++;
    of(d.loser).losses++;
  }
  return [...by.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.tokenId - b.tokenId);
}

/** 1, 2 or 3 for the boxes that wear a rosette (at least one win), null for the others. */
export function rosettePlace(standings: readonly DuelStanding[], tokenId: number): number | null {
  const i = standings.findIndex((s) => s.tokenId === tokenId);
  return i >= 0 && i < ROSETTES && standings[i]!.wins > 0 ? i + 1 : null;
}

/**
 * How a player earns points towards the mainnet allow list. Each opponent counts once, beaten or
 * faced, and a duel against yourself counts nothing: a hundred duels between two of your own
 * wallets are worth one opponent. Openings are capped for the same reason.
 */
export const ALLOW_LIST_POINTS = { beaten: 3, faced: 1, opened: 2, maxOpened: 10 } as const;

export interface PlayerPoints {
  points: number;
  /** Distinct opponents this player beat in a duel. */
  beaten: number;
  /** Distinct opponents this player met in a duel, won or lost. */
  faced: number;
  /** Boxes this player opened. */
  opened: number;
}

/** `account`'s points from the settled duels and the openers of every opened box. */
export function playerPoints(account: string, duels: readonly SettledDuel[], openers: readonly string[]): PlayerPoints {
  const me = account.toLowerCase();
  const beaten = new Set<string>();
  const faced = new Set<string>();
  for (const d of duels) {
    const challenger = d.challenger.toLowerCase();
    const accepter = d.accepter.toLowerCase();
    if (challenger === accepter) continue;
    const mine = challenger === me ? d.tokenA : accepter === me ? d.tokenB : null;
    if (mine === null) continue;
    const other = challenger === me ? accepter : challenger;
    faced.add(other);
    if (d.winner === mine) beaten.add(other);
  }
  const opened = openers.filter((o) => o.toLowerCase() === me).length;
  const p = ALLOW_LIST_POINTS;
  return {
    points: beaten.size * p.beaten + faced.size * p.faced + Math.min(opened, p.maxOpened) * p.opened,
    beaten: beaten.size,
    faced: faced.size,
    opened,
  };
}

/** Seats on the mainnet list, first come, first served, from the spec unless the API is told
 *  otherwise (`ALLOW_LIST_PLACES`). Inside, points set the rank, and the rank the gift. */
export const DEFAULT_ALLOW_LIST_PLACES: number | null = spec.whitelist.places;

/** What a player signs to claim a place. The address line is what the API checks. */
export function allowListMessage(account: string, issuedAt: Date): string {
  return [
    `I, ${account.toLowerCase()}, claim a place on the DO NOT OPEN mainnet allow list.`,
    "Places go to the claimants with the most points when the list closes.",
    `Issued at: ${issuedAt.toISOString()}`,
  ].join("\n");
}

/** The address a claim message names, or null when it is not one. */
export function allowListAddress(message: string): string | null {
  return /^I, (0x[0-9a-fA-F]{40}), claim a place on the DO NOT OPEN mainnet allow list\.$/m.exec(message)?.[1]?.toLowerCase() ?? null;
}

/** A claim as the ranking sees it: the best points the player ever had, and when they claimed. */
export interface ClaimRank {
  address: string;
  points: number;
  claimedAt: number;
}

/** Claimants ranked: most points first, then the earlier claim. */
export const byClaimRank = (a: ClaimRank, b: ClaimRank): number => b.points - a.points || a.claimedAt - b.claimedAt || (a.address < b.address ? -1 : 1);

/** What a player signs to link a wallet to their X boarding pass. The first line is what the API checks. */
export function xPassWalletMessage(account: string, code: string, issuedAt: Date): string {
  return [`I, ${account.toLowerCase()}, link this wallet to my DO NOT OPEN boarding pass ${code}.`, "It adds my testnet points to the mainnet whitelist.", `Issued at: ${issuedAt.toISOString()}`].join("\n");
}

/** Points a verified X boarding pass adds to the wallet it links. */
export const X_PASS_BONUS = 5;

/** Points a boarding pass adds on top, once its holder joined the Discord server (`/board`). */
export const DISCORD_BONUS = 3;

/** Points a boarding pass adds for each pass it referred (`?ref=<code>`) that took a seat and
 *  linked a wallet, up to REFERRAL_CAP of them. */
export const REFERRAL_BONUS = 2;
export const REFERRAL_CAP = 10;
