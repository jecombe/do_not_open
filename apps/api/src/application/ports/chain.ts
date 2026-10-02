import type { DuelSnapshot, ProtocolEvent, RequestSnapshot, Snapshots } from "../../domain/events";
import type { AliveCheck, BoxStatus, TraitRoll } from "../../domain/types";

/** What one read of the chain brought back. `to` may stop short of what was asked. */
export interface ChainBatch {
  /** Last block covered: every event of `from..to` is in `events`. */
  to: number;
  events: ProtocolEvent[];
  snapshots: Snapshots;
  /** The endpoints that answered, so a later check can ask others. */
  servedBy: string[];
}

export interface ReadOptions {
  /** Endpoints to avoid if any other can answer. */
  exclude?: string[];
}

/** Boxes, duels and requests to fetch every event of, wherever they are. */
export interface EntityQuery {
  tokenIds?: number[];
  duelIds?: number[];
  requestIds?: number[];
  /** Every MilestoneReached: they carry no box, duel or request to look them up by. */
  milestones?: boolean;
}

/** The logs of the protocol, decoded, and what the views add to them. */
export interface ChainSource {
  head(): Promise<number>;
  /** The last block the chain will never revert. */
  finalized(): Promise<number>;
  /** Events of `from..to` in chain order. May cover fewer blocks than asked (see `ChainBatch.to`). */
  read(from: number, to: number, opts?: ReadOptions): Promise<ChainBatch>;
  /** Every event about these entities in `from..to`, the whole range. For repairs: rare and targeted. */
  eventsOf(q: EntityQuery, from: number, to: number): Promise<Pick<ChainBatch, "events" | "snapshots">>;
}

/** How many of each thing the contract has made, at a block. */
export interface Counters {
  tokenCount: number;
  duelCount: number;
  requestCount: number;
  milestonesReached: number;
}

/** What the contract's views say about a box, to compare with the index. */
export interface BoxView {
  tokenId: number;
  status: BoxStatus;
  aliveCheck: AliveCheck;
  partner: number | null;
  wins: number;
  publicTraits: TraitRoll[];
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
    /** Constant-product reserves the pool prices with: on V3, the active range's virtual ones. */
    croqReserve: string;
    quoteReserve: string;
    /** What the pool actually holds. */
    croqHeld: string;
    quoteHeld: string;
    /** Quote units per 1,000 CROQ where the locked range starts and ends. */
    range: { from: string; to: string } | null;
  } | null;
}

/** Live reads of contract state that no event carries. Implementations cache them. */
export interface ChainState {
  collection(): Promise<CollectionConstants>;
  economy(): Promise<EconomyState | null>;
  /** Unix seconds from which a box can claim croquettes again. */
  nextClaimAt(tokenId: number): Promise<number>;

  // Reads at a given block, uncached: the reconciliation compares them with the index as of that block.
  counters(atBlock: number): Promise<Counters>;
  duelViews(ids: number[], atBlock: number): Promise<Map<number, DuelSnapshot>>;
  requestViews(ids: number[], atBlock: number): Promise<Map<number, RequestSnapshot>>;
  boxViews(ids: number[], atBlock: number): Promise<BoxView[]>;
}
