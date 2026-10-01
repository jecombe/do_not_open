import type { ProtocolEvent, Snapshots } from "../../domain/events";

/** What one read of the chain brought back. `to` may stop short of what was asked. */
export interface ChainBatch {
  /** Last block covered: every event of `from..to` is in `events`. */
  to: number;
  events: ProtocolEvent[];
  snapshots: Snapshots;
}

/** The logs of the protocol, decoded, and what the views add to them. */
export interface ChainSource {
  head(): Promise<number>;
  /** Events of `from..to` in chain order. May cover fewer blocks than asked (see `ChainBatch.to`). */
  read(from: number, to: number): Promise<ChainBatch>;
}

/** Fees and limits fixed at deployment, read once. Amounts in the payment token's smallest unit. */
export interface CollectionConstants {
  chain: string;
  chainId: number;
  address: string;
  explorerUrl: string | null;
  fees: { mint: string; observe: string; feed: string; paidShake: string };
  maxSupply: number;
  maxPerTx: number;
  milestones: number[];
  rampFeeBps: number | null;
  usdcFaucet: string | null;
}

/** The croquette economy: constants, and what moves (wrapped supply, halvings, pool). */
export interface EconomyState {
  symbol: string;
  confidentialSymbol: string;
  totalSupply: string;
  wrapped: string;
  welcomeBag: number;
  purrMaxPerDay: number;
  vetMultiplier: number;
  purrMaxDays: number;
  halvings: number;
  halvingPeriod: number;
  mealsPerDay: number;
  maxEatenPerDay: string;
  mealTreasuryBps: number;
  mealBurnBps: number;
  maxBoxesPerClaim: number;
  links: { croq: string | null; cCroq: string | null; pantry: string | null };
  market: {
    name: string;
    poolUrl: string | null;
    appUrl: string | null;
    quote: { symbol: string; decimals: number };
    croqReserve: string;
    quoteReserve: string;
  } | null;
}

/** Live reads of contract state that no event carries. Implementations cache them. */
export interface ChainState {
  collection(): Promise<CollectionConstants>;
  economy(): Promise<EconomyState | null>;
  /** Unix seconds from which a box can claim croquettes again. */
  nextClaimAt(tokenId: number): Promise<number>;
}
