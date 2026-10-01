import type { ChainBatch, ChainSource, ChainState, CollectionConstants, EconomyState } from "../src/application/ports/chain";
import { emptySnapshots, type EventName, type EventOf, type ProtocolEvent, type Snapshots } from "../src/domain/events";

export const ALICE = "0x00000000000000000000000000000000000a11ce";
export const BOB = "0x0000000000000000000000000000000000000b0b";
export const CAROL = "0x00000000000000000000000000000000000ca201";

let counter = 0;

type Body<N extends EventName> = Omit<EventOf<N>, "name" | "source" | "block" | "timestamp" | "txHash" | "logIndex">;

/** An event at `block`, with a unique transaction hash unless one is given. */
export function ev<N extends EventName>(name: N, block: number, body: Body<N>, at: { txHash?: string; logIndex?: number; timestamp?: number | null } = {}): EventOf<N> {
  counter++;
  const source = ["MealServed", "WelcomeBag", "Purred", "Claimed", "WeighInRequested", "Weighed"].includes(name) ? "pantry" : name === "Bought" ? "ramp" : "collection";
  return {
    name,
    source,
    block,
    timestamp: at.timestamp === undefined ? 1_790_000_000 + block * 12 : at.timestamp,
    txHash: at.txHash ?? `0x${counter.toString(16).padStart(64, "0")}`,
    logIndex: at.logIndex ?? 0,
    ...body,
  } as EventOf<N>;
}

/** A chain in memory: events by block, snapshots as the views would answer, a head to move. */
export class FakeChain implements ChainSource {
  head_ = 0;
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

  async read(from: number, to: number): Promise<ChainBatch> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const end = Math.min(to, from + this.span - 1);
    this.reads.push([from, end]);
    return {
      to: end,
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
