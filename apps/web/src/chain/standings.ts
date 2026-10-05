import { useEffect, useState } from "react";
import { rosettePlace, type DuelStanding } from "@dno/chain-adapter";
import { useChain } from "./ChainProvider";

/**
 * The duel ranking, read once per page and again when the sale moves. Null while it loads, or if
 * it could not be read: nothing wears a rosette then.
 */
export function useDuelStandings(key: unknown = null): DuelStanding[] | null {
  const { adapter, collection } = useChain();
  const [standings, setStandings] = useState<DuelStanding[] | null>(null);
  const stamp = collection?.tokenCount;
  useEffect(() => {
    let live = true;
    adapter.duelStandings().then(
      (s) => live && setStandings(s),
      () => live && setStandings(null),
    );
    return () => {
      live = false;
    };
  }, [adapter, stamp, key]);
  return standings;
}

/** The rosette a box wears, if it is one of the ranking's top three. */
export function rosetteOf(standings: readonly DuelStanding[] | null, tokenId: number): { place: number; wins: number } | null {
  if (!standings) return null;
  const place = rosettePlace(standings, tokenId);
  return place ? { place, wins: standings[place - 1]!.wins } : null;
}
