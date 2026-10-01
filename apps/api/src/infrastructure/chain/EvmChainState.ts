import { Interface } from "ethers";
import type { ChainState, CollectionConstants, EconomyState } from "../../application/ports/chain";
import { Batcher, TtlCache } from "../cache";
import type { ProtocolDeployment } from "./deployment";
import { multicall } from "./multicall";
import type { RpcPool } from "./RpcPool";

const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const PAIR = new Interface(["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)", "function token0() view returns (address)"]);
const RAMP = new Interface(["function feeBps() view returns (uint16)"]);

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
