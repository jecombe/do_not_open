import type { BoxView, ChainBatch, ChainSource, ChainState, CollectionConstants, Counters, EconomyState, EntityQuery, ReadOptions } from "../src/application/ports/chain";
import { emptySnapshots, tokensOf, type DuelSnapshot, type EventName, type EventOf, type ProtocolEvent, type RequestSnapshot, type Snapshots } from "../src/domain/events";

export const ALICE = "0x00000000000000000000000000000000000a11ce";
export const BOB = "0x0000000000000000000000000000000000000b0b";
export const CAROL = "0x00000000000000000000000000000000000ca201";

let counter = 0;

type Body<N extends EventName> = Omit<EventOf<N>, "name" | "source" | "block" | "blockHash" | "timestamp" | "txHash" | "logIndex">;

/** The canonical hash of a block in these tests; a reorg is a different one. */
export const hashOf = (block: number, fork = "") => `0x${fork}${block.toString(16).padStart(64 - fork.length, "0")}`;

/** An event at `block`, with a unique transaction hash unless one is given. */
export function ev<N extends EventName>(name: N, block: number, body: Body<N>, at: { txHash?: string; logIndex?: number; timestamp?: number | null; blockHash?: string } = {}): EventOf<N> {
  counter++;
  const source = ["MealServed", "WelcomeBag", "Purred", "Claimed", "WeighInRequested", "Weighed"].includes(name) ? "pantry" : name === "Bought" ? "ramp" : name === "PackBought" ? "studio" : name === "RatMinted" || name === "RatTransfer" ? "rats" : name === "RatsFed" ? "ratPantry" : name === "RatSniffed" || name === "RatTrick" ? "ratTricks" : "collection";
  return {
    name,
    source,
    block,
    blockHash: at.blockHash ?? hashOf(block),
    timestamp: at.timestamp === undefined ? 1_790_000_000 + block * 12 : at.timestamp,
    txHash: at.txHash ?? `0x${counter.toString(16).padStart(64, "0")}`,
    logIndex: at.logIndex ?? 0,
    ...body,
  } as EventOf<N>;
}

/** A chain in memory: events by block, snapshots as the views would answer, a head to move. */
export class FakeChain implements ChainSource {
  head_ = 0;
  finalized_ = 0;
  /** Endpoint names, one per read, in turn; what `exclude` avoids. */
  endpoints = ["rpc-a", "rpc-b"];
  excluded: string[][] = [];
  entityQueries: EntityQuery[] = [];
  events: ProtocolEvent[] = [];
  snapshots: Snapshots = emptySnapshots();
  /** Widest range one `read` covers, like an endpoint's log limit. */
  span = Infinity;
  reads: [number, number][] = [];
  failNext: Error | null = null;
  /** Events a lagging node does not return yet, until released. */
  hidden = new Set<ProtocolEvent>();

  add(...events: ProtocolEvent[]) {
    this.events.push(...events);
    this.head_ = Math.max(this.head_, ...events.map((e) => e.block));
    return this;
  }

  async head() {
    return this.head_;
  }

  async finalized() {
    return this.finalized_;
  }

  async eventsOf(q: EntityQuery, from: number, to: number): Promise<Pick<ChainBatch, "events" | "snapshots">> {
    this.entityQueries.push(q);
    const tokens = new Set(q.tokenIds ?? []);
    const events = this.events.filter(
      (e) =>
        e.block >= from &&
        e.block <= to &&
        (tokensOf(e).some((t) => tokens.has(t)) ||
          ("duelId" in e && q.duelIds?.includes(e.duelId)) ||
          ("requestId" in e && q.requestIds?.includes(e.requestId)) ||
          (q.milestones && e.name === "MilestoneReached")),
    );
    return { events: structuredClone(events), snapshots: structuredClone(this.snapshots) };
  }

  async read(from: number, to: number, opts: ReadOptions = {}): Promise<ChainBatch> {
    this.excluded.push(opts.exclude ?? []);
    const endpoint = this.endpoints.find((n) => !opts.exclude?.includes(n)) ?? this.endpoints[0]!;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const end = Math.min(to, from + this.span - 1);
    this.reads.push([from, end]);
    return {
      to: end,
      servedBy: [endpoint],
      events: this.events.filter((e) => e.block >= from && e.block <= end && !this.hidden.has(e)).map((e) => structuredClone(e)),
      snapshots: structuredClone(this.snapshots),
    };
  }
}

export const COLLECTION: CollectionConstants = {
  chain: "Sepolia",
  chainId: 11155111,
  address: "0xDdC71FeBA832c961770F59d0be4B0b3ae536707B",
  explorerUrl: "https://sepolia.etherscan.io/address/0xDdC71FeBA832c961770F59d0be4B0b3ae536707B",
  fees: { mint: "5000000", observe: "1000000", feed: "500000", paidShake: "2500000" },
  maxSupply: 10000,
  maxPerTx: 10,
  milestones: [100, 500, 1000],
  rampFeeBps: 30,
  usdcFaucet: "100000000",
};

export class FakeChainState implements ChainState {
  claimReads = 0;
  economyValue: EconomyState | null = null;
  /** What the contract's views answer, set by each test. */
  countersValue: Counters = { tokenCount: 0, duelCount: 0, requestCount: 0, milestonesReached: 0 };
  duels = new Map<number, DuelSnapshot>();
  requests = new Map<number, RequestSnapshot>();
  boxes = new Map<number, BoxView>();
  readAt: number[] = [];
  async counters(atBlock: number) {
    this.readAt.push(atBlock);
    return this.countersValue;
  }
  async duelViews(ids: number[]) {
    return new Map(ids.flatMap((id) => (this.duels.has(id) ? [[id, this.duels.get(id)!] as const] : [])));
  }
  async requestViews(ids: number[]) {
    return new Map(ids.flatMap((id) => (this.requests.has(id) ? [[id, this.requests.get(id)!] as const] : [])));
  }
  async boxViews(ids: number[]) {
    return ids.flatMap((id) => (this.boxes.has(id) ? [this.boxes.get(id)!] : []));
  }
  async collection() {
    return COLLECTION;
  }
  async economy() {
    return this.economyValue;
  }
  async nextClaimAt(tokenId: number) {
    this.claimReads++;
    return 1_800_000_000 + tokenId;
  }
}
