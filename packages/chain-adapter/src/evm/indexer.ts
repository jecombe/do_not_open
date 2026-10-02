import type {
  Address,
  BoxPantry,
  BoxStatus,
  BoxSummary,
  CollectionInfo,
  DecryptionAllowance,
  DuelInfo,
  EconomyInfo,
  MarketInfo,
  OpenedCat,
  PairInfo,
  PendingRequest,
  RequestKind,
  RevealedContents,
  TraitRoll,
  WeighIn,
} from "../types";

/** An answer of the API: `data` is true as of `block`, the last block it indexed. */
export interface Indexed<T> {
  block: number | null;
  data: T;
}

/** What the API knows of a box. Whether it is the account's, and its requests, are added by the adapter. */
export interface IndexedBox {
  tokenId: number;
  status: Exclude<BoxStatus, "opening">;
  aliveCheck: "none" | "alive" | "notAlive";
  partner: number | null;
  wins: number;
  publicTraits: TraitRoll[];
  revealed: RevealedContents | null;
}

/** A transfer receipt the account appears in. Its "moved" bit is for the account to decrypt. */
export interface IndexedTransfer {
  tokenId: number;
  from: Address;
  to: Address;
  moved: string;
  block: number;
  txHash: string;
  logIndex: number;
}

export interface DuelQuery {
  account?: Address;
  tokenIds?: number[];
  open?: boolean;
}

type Json = Record<string, any>;

const revealedFrom = (r: Json | null): RevealedContents | null => (r ? { ...r, seed: BigInt(r.seed) } as RevealedContents : null);
const weighInFrom = (w: Json | null): WeighIn | null => (w ? { ...w, weight: BigInt(w.weight), tolerance: BigInt(w.tolerance) } as WeighIn : null);
const duelFrom = (d: Json): DuelInfo => ({
  duelId: d.duelId,
  tokenA: d.tokenA,
  tokenB: d.tokenB ?? null,
  reserved: !!d.reserved,
  challenger: d.challenger,
  accepter: d.accepter,
  status: d.status,
  openUntil: d.openUntil ?? null,
});

/**
 * The DO NOT OPEN API: the protocol indexed in a database, so the app reads one cached source
 * instead of asking a public RPC for every box. Plain fetch, no dependency.
 *
 * It is a shortcut, never the only way: after a failure it stays aside for a while and the
 * adapter reads the chain, as it would without it.
 */
export class IndexerClient {
  private downUntil = 0;
  private lastNudge = -Infinity;

  constructor(
    private readonly baseUrl: string,
    private readonly opts: { timeoutMs?: number; retryAfterMs?: number; fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** False for a while after a failure: callers go to the chain meanwhile. */
  available(): boolean {
    return this.now() >= this.downUntil;
  }

  private async get<T>(path: string, map: (data: any) => T): Promise<Indexed<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 6000);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
      const body = (await res.json()) as Indexed<unknown>;
      return { block: body.block, data: map(body.data) };
    } catch (error) {
      this.downUntil = this.now() + (this.opts.retryAfterMs ?? 30_000);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tells the indexer a transaction just went through, so it looks sooner. Never fails, at most once every few seconds. */
  nudge(): void {
    if (this.now() - this.lastNudge < 3000 || !this.available()) return;
    this.lastNudge = this.now();
    void (this.opts.fetch ?? fetch)(`${this.baseUrl}/v1/sync/nudge`, { method: "POST" }).catch(() => undefined);
  }

  collection(base: Pick<CollectionInfo, "payment">): Promise<Indexed<CollectionInfo>> {
    return this.get("/v1/collection", (c: Json) => ({
      chain: c.chain,
      address: c.address,
      explorerUrl: c.explorerUrl,
      currency: c.currency,
      payment: { ...base.payment, ramp: c.payment.ramp },
      maxSupply: c.maxSupply,
      maxPerTx: c.maxPerTx,
      tokenCount: c.tokenCount,
      sale: c.sale,
      fees: { mint: BigInt(c.fees.mint), observe: BigInt(c.fees.observe), feed: BigInt(c.fees.feed), paidShake: BigInt(c.fees.paidShake) },
    }));
  }

  box(tokenId: number): Promise<Indexed<IndexedBox>> {
    return this.get(`/v1/boxes/${tokenId}`, (b: Json) => ({
      tokenId: b.tokenId,
      status: b.status,
      aliveCheck: b.aliveCheck,
      partner: b.partner,
      wins: b.wins,
      publicTraits: b.publicTraits,
      revealed: revealedFrom(b.revealed),
    }));
  }

  /** Without `mine`: the adapter knows which are the account's, the API never does. */
  boxSummaries(from: number, to: number): Promise<Indexed<Omit<BoxSummary, "mine">[]>> {
    return this.get(`/v1/boxes?from=${from}&to=${to}`, (list: Json[]) => list.map((b) => ({ tokenId: b.tokenId, status: b.status, partner: b.partner })));
  }

  pair(a: number, b: number): Promise<Indexed<PairInfo>> {
    return this.get(`/v1/pairs/${a}/${b}`, (p: Json) => ({ duels: (p.duels as Json[]).map(duelFrom), entangleProposal: p.entangleProposal }));
  }

  openedCats(): Promise<Indexed<OpenedCat[]>> {
    return this.get("/v1/leaderboard", (list: Json[]) => list.map((c) => ({ tokenId: c.tokenId, openedBy: c.openedBy, revealed: revealedFrom(c.revealed)! })));
  }

  pendingRequests(owner: Address): Promise<Indexed<PendingRequest[]>> {
    return this.get(`/v1/accounts/${owner}/requests`, (list: Json[]) =>
      list.map((r) => ({ requestId: r.requestId, kind: r.kind as RequestKind, tokenId: r.tokenId, other: r.other })),
    );
  }

  transfers(account: Address, afterBlock: number): Promise<Indexed<IndexedTransfer[]>> {
    return this.get(`/v1/accounts/${account}/transfers?after=${Math.max(0, afterBlock)}`, (list: IndexedTransfer[]) => list);
  }

  /** The boxes in `tokenIds` are the account's secret: they go in this query and are not kept. */
  duels(q: DuelQuery): Promise<Indexed<DuelInfo[]>> {
    const params = new URLSearchParams();
    if (q.account) params.set("account", q.account);
    if (q.tokenIds?.length) params.set("tokens", q.tokenIds.join(","));
    if (q.open) params.set("open", "true");
    return this.get(`/v1/duels?${params}`, (list: Json[]) => list.map(duelFrom));
  }

  /** Every box up for a duel that can still be taken up. */
  duelShelf(): Promise<Indexed<DuelInfo[]>> {
    return this.get("/v1/duels/shelf", (list: Json[]) => list.map(duelFrom));
  }

  economy(base: Pick<EconomyInfo, "links">): Promise<Indexed<EconomyInfo>> {
    return this.get("/v1/economy", (e: Json) => ({
      ...e,
      links: e.links ?? base.links,
      totalSupply: BigInt(e.totalSupply),
      wrapped: BigInt(e.wrapped),
      maxEatenPerDay: BigInt(e.maxEatenPerDay),
      market: e.market ? marketFrom(e.market) : null,
    }) as EconomyInfo);
  }

  /** What the relayer proxy still lets the account decrypt today. Never cached. */
  allowance(account: Address): Promise<Indexed<Omit<DecryptionAllowance, "price">>> {
    return this.get(`/v1/relayer/allowance/${account}`, (a: Json) => ({ freePerDay: a.freePerDay, freeLeft: a.freeLeft, credits: a.credits, resetsAt: a.resetsAt, inputUnits: a.inputUnits ?? 0 }));
  }

  boxPantry(tokenId: number): Promise<Indexed<BoxPantry>> {
    return this.get(`/v1/boxes/${tokenId}/pantry`, (p: Json) => ({ welcomed: p.welcomed, nextClaimAt: p.nextClaimAt, weighing: p.weighing, weighIn: weighInFrom(p.weighIn) }));
  }
}

/** An API older than the V3 pool sends neither the held amounts nor the range. */
function marketFrom(m: Json): MarketInfo {
  return {
    ...m,
    croqReserve: BigInt(m.croqReserve),
    quoteReserve: BigInt(m.quoteReserve),
    croqHeld: BigInt(m.croqHeld ?? m.croqReserve),
    quoteHeld: BigInt(m.quoteHeld ?? m.quoteReserve),
    range: m.range ? { from: BigInt(m.range.from), to: BigInt(m.range.to) } : null,
  } as MarketInfo;
}
