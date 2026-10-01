import type { AliveCheck, Address, BoxStatus, RevealedContents, TraitRoll, WeighIn, Weighing } from "./types";

/**
 * What the chain made public about one box. Who holds it is not here and never will be: it is
 * encrypted on-chain, and the backend has no way, and no business, to know it.
 */
export interface Box {
  tokenId: number;
  status: BoxStatus;
  aliveCheck: AliveCheck;
  partner: number | null;
  wins: number;
  /** Traits lost duels made public while the box is sealed, one per trait index. */
  publicTraits: TraitRoll[];
  revealed: RevealedContents | null;
  /** Opening is the one act that makes a holder public. */
  openedBy: Address | null;
  openedBlock: number | null;
  mintedBlock: number;
  /** Croquettes: whether its welcome bag was paid, and how far its weigh-in went. */
  welcomed: boolean;
  weighing: Weighing;
  weighIn: WeighIn | null;
}

export function minted(tokenId: number, block: number): Box {
  return {
    tokenId,
    status: "sealed",
    aliveCheck: "none",
    partner: null,
    wins: 0,
    publicTraits: [],
    revealed: null,
    openedBy: null,
    openedBlock: null,
    mintedBlock: block,
    welcomed: false,
    weighing: "none",
    weighIn: null,
  };
}

export const reveal = (b: Box, contents: RevealedContents, openedBy: Address, block: number): Box =>
  b.status === "revealed" ? b : { ...b, status: "revealed", revealed: contents, openedBy, openedBlock: block };

export const proveAlive = (b: Box, alive: boolean): Box => (b.aliveCheck !== "none" ? b : { ...b, aliveCheck: alive ? "alive" : "notAlive" });

export const entangle = (b: Box, partner: number): Box => (b.partner !== null ? b : { ...b, partner });

export const winDuel = (b: Box): Box => ({ ...b, wins: b.wins + 1 });

/** A lost duel shows one trait. Losing again on the same trait shows the same roll. */
export function loseDuel(b: Box, shown: TraitRoll): Box {
  if (b.publicTraits.some((t) => t.traitIndex === shown.traitIndex)) return b;
  return { ...b, publicTraits: [...b.publicTraits, shown].sort((x, y) => x.traitIndex - y.traitIndex) };
}

export const welcome = (b: Box): Box => (b.welcomed ? b : { ...b, welcomed: true });

export const weighRequested = (b: Box): Box => (b.weighing === "done" ? b : { ...b, weighing: "pending" });

export const weighed = (b: Box, weighIn: WeighIn): Box => ({ ...b, weighing: "done", weighIn });
