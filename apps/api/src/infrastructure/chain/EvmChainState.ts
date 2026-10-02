import { Interface } from "ethers";
import type { BoxView, ChainState, CollectionConstants, Counters, EconomyState } from "../../application/ports/chain";
import type { DuelSnapshot, RequestSnapshot } from "../../domain/events";
import { normalizeAddress, ZERO_ADDRESS, type AliveCheck, type BoxStatus, type DuelStatus, type RequestKind, type RequestStatus } from "../../domain/types";
import { Batcher, TtlCache } from "../cache";
import type { ProtocolDeployment } from "./deployment";
import { duelSnapshot } from "./EvmChainSource";
import { multicall } from "./multicall";
import type { RpcPool } from "./RpcPool";

const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const PAIR = new Interface(["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)", "function token0() view returns (address)"]);
const RAMP = new Interface(["function feeBps() view returns (uint16)"]);
const BOX_STATUS: BoxStatus[] = ["sealed", "revealed"];
const ALIVE_CHECK: AliveCheck[] = ["none", "alive", "notAlive"];
const REQUEST_KINDS: RequestKind[] = ["open", "aliveCheck", "entangle"];
const REQUEST_STATUS: (RequestStatus | null)[] = [null, "pending", "done", "refused"];

export interface ChainStateOptions {
  /** How long the moving parts of the economy (wrapped supply, halvings, pool) are kept. */
  economyTtlMs: number;
  /** How long a box's next claim time is kept. */
  claimTtlMs: number;
}

/**
 * Contract state no event carries, read through Multicall3 and cached: constants once,
 * the rest for a few seconds. However many visitors ask, the RPC sees one read per period.
 */
export class EvmChainState implements ChainState {
  private readonly collectionIface: Interface;
  private readonly pantryIface: Interface | null;
  private constants: Promise<CollectionConstants> | null = null;
  private contracts: Promise<string[]> | null = null;
  private economyConstants: Promise<Omit<EconomyState, "wrapped" | "halvings" | "market">> | null = null;
  private readonly economyCache: TtlCache<"economy", EconomyState | null>;
  private readonly claimCache: TtlCache<number, number>;
  private readonly claims: Batcher<number, number>;

  constructor(
    private readonly rpc: RpcPool,
    private readonly d: ProtocolDeployment,
    opts: ChainStateOptions,
  ) {
    this.collectionIface = new Interface(d.collection.abi);
    this.pantryIface = d.pantry ? new Interface(d.pantry.abi) : null;
    this.economyCache = new TtlCache(opts.economyTtlMs);
    this.claimCache = new TtlCache(opts.claimTtlMs);
    this.claims = new Batcher((ids) => this.readClaims(ids));
  }

  collection(): Promise<CollectionConstants> {
    this.constants ??= this.readConstants();
    this.constants.catch(() => (this.constants = null));
    return this.constants;
  }

  private async readConstants(): Promise<CollectionConstants> {
    const c = { target: this.d.collection.address, iface: this.collectionIface };
    const r = await multicall(this.rpc, [
      { ...c, fn: "mintPrice", args: [] },
      { ...c, fn: "observeFee", args: [] },
      { ...c, fn: "feedFee", args: [] },
      { ...c, fn: "paidShakeFee", args: [] },
      { ...c, fn: "maxSupply", args: [] },
      { ...c, fn: "maxPerTx", args: [] },
      { ...c, fn: "milestones", args: [] },
      ...(this.d.ramp ? [{ target: this.d.ramp.address, iface: RAMP, fn: "feeBps", args: [] }] : []),
    ]);
    if (r.slice(0, 7).some((x) => x === null)) throw new Error("collection constants unreadable");
    const v = (i: number) => r[i]![0];
    const explorer = this.d.explorerUrl;
    return {
      chain: this.d.name,
      chainId: this.d.chainId,
      address: this.d.collection.address,
      explorerUrl: explorer ? `${explorer}/address/${this.d.collection.address}` : null,
      fees: { mint: String(v(0)), observe: String(v(1)), feed: String(v(2)), paidShake: String(v(3)) },
      maxSupply: Number(v(4)),
      maxPerTx: Number(v(5)),
      milestones: [...v(6)].map(Number),
      rampFeeBps: this.d.ramp && r[7] ? Number(r[7][0]) : null,
      usdcFaucet: this.d.usdcFaucet === null ? null : String(this.d.usdcFaucet),
    };
  }

  /**
   * The contracts the relayer proxy decrypts for and makes inputs for, lowercase: the
   * collection and the cUSDC it is paid in, the Pantry and cCROQ. Read once.
   */
  decryptable(): Promise<string[]> {
    this.contracts ??= multicall(this.rpc, [{ target: this.d.collection.address, iface: this.collectionIface, fn: "confidentialUsdc", args: [] }]).then((r) => {
      if (!r[0]) throw new Error("the collection's cUSDC is unreadable");
      return [this.d.collection.address, String(r[0][0]), this.d.pantry?.address, this.d.cCroq?.address].filter((a): a is string => !!a).map(normalizeAddress);
    });
    this.contracts.catch(() => (this.contracts = null));
    return this.contracts;
  }

  economy(): Promise<EconomyState | null> {
    return this.economyCache.get("economy", () => this.readEconomy());
  }

  private link(address: string): string | null {
    return this.d.explorerUrl ? `${this.d.explorerUrl}/address/${address}` : null;
  }

  private async readEconomy(): Promise<EconomyState | null> {
    const { pantry, croq, cCroq, market } = this.d;
    if (!pantry || !croq || !cCroq || !this.pantryIface) return null;
    const p = { target: pantry.address, iface: this.pantryIface };
    this.economyConstants ??= multicall(this.rpc, [
      { target: croq.address, iface: ERC20, fn: "totalSupply", args: [] },
      ...["welcomeBag", "purrMaxPerDay", "vetMultiplier", "purrMaxDays", "halvingPeriod", "mealsPerDay", "maxEatenPerDay", "mealTreasuryBps", "mealBurnBps", "maxBoxesPerClaim"].map((fn) => ({ ...p, fn, args: [] })),
    ]).then((r) => {
      if (r.some((x) => x === null)) throw new Error("economy constants unreadable");
      const v = (i: number) => r[i]![0];
      return {
        symbol: "CROQ",
        confidentialSymbol: "cCROQ",
        totalSupply: String(v(0)),
        welcomeBag: Number(v(1)),
        purrMaxPerDay: Number(v(2)),
        vetMultiplier: Number(v(3)),
        purrMaxDays: Number(v(4)),
        halvingPeriod: Number(v(5)),
        mealsPerDay: Number(v(6)),
        maxEatenPerDay: String(v(7)),
        mealTreasuryBps: Number(v(8)),
        mealBurnBps: Number(v(9)),
        maxBoxesPerClaim: Number(v(10)),
        links: { croq: this.link(croq.address), cCroq: this.link(cCroq.address), pantry: this.link(pantry.address) },
      };
    });
    this.economyConstants.catch(() => (this.economyConstants = null));

    const [constants, moving] = await Promise.all([
      this.economyConstants,
      multicall(this.rpc, [
        { target: croq.address, iface: ERC20, fn: "balanceOf", args: [cCroq.address] },
        { ...p, fn: "halvings", args: [] },
        ...(market ? [{ target: market.pair, iface: PAIR, fn: "getReserves", args: [] }, { target: market.pair, iface: PAIR, fn: "token0", args: [] }] : []),
      ]),
    ]);
    const [wrapped, halvings, reserves, token0] = moving;
    const croqFirst = token0 && String(token0[0]).toLowerCase() === croq.address.toLowerCase();
    return {
      ...constants,
      wrapped: String(wrapped?.[0] ?? 0n),
      halvings: Number(halvings?.[0] ?? 0),
      market:
        market && reserves
          ? {
              name: "Uniswap V2",
              poolUrl: this.link(market.pair),
              appUrl: `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=${market.usdc}&outputCurrency=${croq.address}`,
              quote: { symbol: "USDC", decimals: 6 },
              croqReserve: String(croqFirst ? reserves[0] : reserves[1]),
              quoteReserve: String(croqFirst ? reserves[1] : reserves[0]),
            }
          : null,
    };
  }

  nextClaimAt(tokenId: number): Promise<number> {
    return this.claimCache.get(tokenId, () => this.claims.load(tokenId));
  }

  async counters(atBlock: number): Promise<Counters> {
    const c = { target: this.d.collection.address, iface: this.collectionIface, args: [] };
    const r = await multicall(this.rpc, ["tokenCount", "duelCount", "requestCount", "milestonesReached"].map((fn) => ({ ...c, fn })), atBlock);
    if (r.some((x) => x === null)) throw new Error("counters unreadable");
    const [tokenCount, duelCount, requestCount, milestonesReached] = r.map((x) => Number(x![0]));
    return { tokenCount: tokenCount!, duelCount: duelCount!, requestCount: requestCount!, milestonesReached: milestonesReached! };
  }

  async duelViews(ids: number[], atBlock: number): Promise<Map<number, DuelSnapshot>> {
    const r = await multicall(this.rpc, ids.map((id) => ({ target: this.d.collection.address, iface: this.collectionIface, fn: "duelInfo", args: [id] })), atBlock);
    const out = new Map<number, DuelSnapshot>();
    r.forEach((x, i) => {
      if (!x) return;
      out.set(ids[i]!, duelSnapshot(x));
    });
    return out;
  }

  async requestViews(ids: number[], atBlock: number): Promise<Map<number, RequestSnapshot>> {
    const r = await multicall(this.rpc, ids.map((id) => ({ target: this.d.collection.address, iface: this.collectionIface, fn: "requestInfo", args: [id] })), atBlock);
    const out = new Map<number, RequestSnapshot>();
    r.forEach((x, i) => {
      if (!x) return;
      out.set(ids[i]!, {
        kind: REQUEST_KINDS[Number(x.kind)] ?? "open",
        status: REQUEST_STATUS[Number(x.requestStatus)] ?? null,
        requester: normalizeAddress(x.requester),
        tokenId: Number(x.tokenId),
        other: Number(x.other) ? Number(x.other) - 1 : null,
      });
    });
    return out;
  }

  /** Five views a box, in one multicall per 30 boxes. */
  async boxViews(ids: number[], atBlock: number): Promise<BoxView[]> {
    const fns = ["status", "aliveCheck", "partnerOf", "wins", "publicTraitsOf"];
    const r = await multicall(
      this.rpc,
      ids.flatMap((id) => fns.map((fn) => ({ target: this.d.collection.address, iface: this.collectionIface, fn, args: [id] }))),
      atBlock,
    );
    return ids.flatMap((tokenId, i) => {
      const [status, alive, partner, wins, traits] = r.slice(i * fns.length, (i + 1) * fns.length);
      if (!status || !alive || !partner || !wins || !traits) return [];
      const mask = Number(traits.mask);
      return [
        {
          tokenId,
          status: BOX_STATUS[Number(status[0])] ?? "sealed",
          aliveCheck: ALIVE_CHECK[Number(alive[0])] ?? "none",
          partner: partner.entangled ? Number(partner.partner) : null,
          wins: Number(wins[0]),
          publicTraits: [...traits.rolls].flatMap((roll: bigint, traitIndex: number) => (mask & (1 << traitIndex) ? [{ traitIndex, roll: Number(roll) }] : [])),
        },
      ];
    });
  }

  private async readClaims(ids: number[]): Promise<number[]> {
    const pantry = this.d.pantry;
    if (!pantry || !this.pantryIface) return ids.map(() => 0);
    const r = await multicall(
      this.rpc,
      ids.map((id) => ({ target: pantry.address, iface: this.pantryIface!, fn: "nextClaimAt", args: [id] })),
    );
    return r.map((x) => (x ? Number(x[0]) : 0));
  }
}
