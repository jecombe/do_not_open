import type { SettledDuel } from "@dno/chain-adapter/standings";
import type { Duel } from "./duel";

/** More duels than any network will settle: the rankings read them all. */
export const ALL_DUELS = 1_000_000;

/** Settled duels as the rankings read them. Every resolved duel names both parties. */
export function settledDuels(duels: Duel[]): SettledDuel[] {
  return duels.flatMap((d) =>
    d.status === "resolved" && d.winner !== null && d.loser !== null && d.tokenB !== null && d.challenger && d.accepter
      ? [{ tokenA: d.tokenA, tokenB: d.tokenB, challenger: d.challenger, accepter: d.accepter, winner: d.winner, loser: d.loser }]
      : [],
  );
}
