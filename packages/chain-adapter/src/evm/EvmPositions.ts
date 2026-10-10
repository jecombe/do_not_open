import { AbiCoder, Contract, getAddress, keccak256, solidityPackedKeccak256, Wallet, type ContractTransactionReceipt, type InterfaceAbi } from "ethers";
import { amountsForLiquidity, liquidityForAmounts, TICK_SPACING } from "../liquidity";
import { ChainError, sameAddress, type ActionOptions, type Address } from "../types";
import type { PocketToken, PositionOptions, PositionPool, PositionsAdapter, PositionsInfo, PositionStatus, SealedPosition, WalletPosition } from "../vault";
import type { EvmPockets, EvmPocketsTools } from "./EvmPockets";
import type { PositionFundsArgs, PositionOutArgs, PositionRangeArgs } from "./vaultRelay";

/** The positions, as `dno:export` writes them inside the vault's deployment. */
export interface PositionsDeployment {
  address: string;
  abi: InterfaceAbi;
  deployBlock?: number | null;
  uniswap: { factory: string; positionManager: string; swapRouter: string } | null;
  /** 2: SwapRouter02 (no deadline in its params), as on Sepolia; 1: Uniswap's first router, locally. */
  routerVersion?: number;
  /** The pools the deploy opened between the pockets' ERC-20s. */
  pools: { address: string; token0: string; token1: string; fee: number }[];
}

/** What the positions borrow from the vault around them: its tools, its pockets and their one signature. */
export interface PositionsVaultSide {
  pocketTokens(): PocketToken[];
  /** The pockets holding the token that wraps `underlying`. */
  pocketsOf(underlying: string): EvmPockets | null;
  pocketSignature(opts?: ActionOptions): Promise<string>;
}

const STATUS: (PositionStatus | "none")[] = ["none", "funding", "open", "closed", "failed", "out"];
const FUNDING_PENDING = 1;
const ACTION = { collect: 0, decrease: 1, give: 2, takeOut: 3 } as const;
const MAX_UINT128 = (1n << 128n) - 1n;
/** How long a funding may wait for its proofs before Uniswap refuses it (everything then goes back). */
const FUNDING_DEADLINE = 2 * 3600;
/** How long a holder's signature stays good. */
const ACT_DEADLINE = 3600;
const DEFAULT_SLIPPAGE_BPS = 100;
/** Controllers looked at past the last one used, when finding a wallet's positions. */
const LOOK_AHEAD = 3;
const coder = AbiCoder.defaultAbiCoder();
/** Blocks per log query: public RPCs refuse wider ones. */
const LOG_SPAN = 40_000;
const hex = (v: string | Uint8Array) => (typeof v === "string" ? v : "0x" + Array.from(v, (b) => b.toString(16).padStart(2, "0")).join(""));

const NPM_ABI = [
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
];
const ROUTER_V1_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];
const ROUTER_V2_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];

/**
 * The vault's liquidity positions on an EVM chain. Each position is steered by a controller, a
 * key derived from the pockets' one signature and the position's number in the wallet's list
 * ("open" for those it opened, "receive" for those it was given), so nothing is stored and the
 * same wallet finds the same positions on any device. Every transaction goes through the vault's
 * relayer when the API has one.
 */
export class EvmPositions implements PositionsAdapter {
  private readonly read: Contract;
  private readonly npm: Contract | null;
  /** The controllers found for the connected wallet, by position. */
  private found: { account: Address; byPosition: Map<number, Wallet>; next: { open: number; receive: number } } | null = null;
  private lastBlock = 0;
  readonly trade: ((pool: Address, opts?: ActionOptions) => Promise<void>) | null;

  constructor(
    private readonly deployed: PositionsDeployment,
    private readonly side: PositionsVaultSide,
    private readonly t: EvmPocketsTools,
  ) {
    this.read = new Contract(deployed.address, deployed.abi, t.readProvider);
    this.npm = deployed.uniswap ? new Contract(deployed.uniswap.positionManager, NPM_ABI, t.readProvider) : null;
    this.trade = t.faucets && deployed.uniswap ? (pool, opts) => this.roundTrip(pool, opts) : null;
  }

  async info(): Promise<PositionsInfo> {
    const [feeBps, count, pools, relay] = await Promise.all([
      this.t.reading(this.read.feeBps!()),
      this.t.reading(this.read.positionCount!()),
      this.pools(),
      this.t.relay(),
    ]);
    return {
      address: this.deployed.address as Address,
      positionManager: (this.deployed.uniswap?.positionManager ?? "") as Address,
      feeBps: Number(feeBps),
      count: Number(count),
      pools,
      relayer: (relay?.address ?? null) as Address | null,
    };
  }

  async all(): Promise<SealedPosition[]> {
    await this.caughtUp();
    const count = Number(await this.t.reading(this.read.positionCount!()));
    const [pools, pending] = await Promise.all([this.pools(), this.pending()]);
    const ids = Array.from({ length: count }, (_, i) => count - 1 - i);
    return Promise.all(ids.map((id) => this.position(id, pools, pending)));
  }

  async mine(opts?: ActionOptions): Promise<SealedPosition[]> {
    const ids = await this.myIds(opts);
    if (!ids.length) return [];
    const [pools, pending] = await Promise.all([this.pools(), this.pending()]);
    const out = await Promise.all(ids.map((id) => this.position(id, pools, pending)));
    return out.filter((p) => p.status !== "failed" && p.status !== "closed" && p.status !== "out").sort((a, b) => b.positionId - a.positionId);
  }

  async open(pool: Address, tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint, opts?: PositionOptions): Promise<number> {
    const p = await this.poolOrThrow(pool);
    const spacing = TICK_SPACING[p.fee] ?? 60;
    if (tickLower >= tickUpper || tickLower % spacing !== 0 || tickUpper % spacing !== 0) throw new ChainError("unknown", "That range does not sit on the pool's ticks.");
    const range: PositionRangeArgs = { token0: p.token0.underlying.address, token1: p.token1.underlying.address, fee: p.fee, tickLower, tickUpper };
    const controller = await this.nextController("open", opts);
    const { funds, keys } = await this.funding(p, tickLower, tickUpper, amount0, amount1, opts, (f) => this.t.reading(this.read.openHash!(controller.address, range, f)));
    const relay = await this.t.relay();
    const receipt = relay
      ? await this.relayed(opts, "open", () => relay.pockets("positionOpen", { range, controller: controller.address, funds, keys }))
      : await this.sent(opts, () => this.t.writer(this.deployed).open!(range, controller.address, funds, keys));
    const opened = this.events(receipt, "Opened")[0];
    const fundingId = Number(this.events(receipt, "Funded")[0]!.args.fundingId);
    const positionId = Number(opened!.args.positionId);
    this.remember(positionId, controller);
    await this.settleOrThrow(fundingId, opts);
    return positionId;
  }

  async add(positionId: number, amount0: bigint, amount1: bigint, opts?: PositionOptions): Promise<void> {
    const pos = await this.position(positionId, await this.pools());
    if (pos.status !== "open") throw new ChainError("unknown", "This position is not open.");
    const p = await this.poolOrThrow(pos.pool);
    const { funds, keys } = await this.funding(p, pos.tickLower, pos.tickUpper, amount0, amount1, opts, (f) => this.t.reading(this.read.addHash!(positionId, f)));
    const relay = await this.t.relay();
    const receipt = relay
      ? await this.relayed(opts, "add", () => relay.pockets("positionAdd", { positionId, funds, keys }))
      : await this.sent(opts, () => this.t.writer(this.deployed).add!(positionId, funds, keys));
    await this.settleOrThrow(Number(this.events(receipt, "Funded")[0]!.args.fundingId), opts);
  }

  async collect(positionId: number, opts?: PositionOptions): Promise<{ amount0: bigint; amount1: bigint }> {
    const { controller, pool } = await this.steer(positionId, opts);
    const out = await this.out(pool, opts);
    const terms = String(await this.t.reading(this.read.outHash!(out)));
    const { deadline, signature } = await this.sign(controller, positionId, ACTION.collect, terms);
    const relay = await this.t.relay();
    const receipt = relay
      ? await this.relayed(opts, "collect", () => relay.pockets("positionCollect", { positionId, out, deadline, signature }))
      : await this.sent(opts, () => this.t.writer(this.deployed).collect!(positionId, out, deadline, signature));
    return this.netFees(receipt);
  }

  async remove(positionId: number, shareBps: number, opts?: PositionOptions): Promise<{ amount0: bigint; amount1: bigint }> {
    if (!(shareBps > 0 && shareBps <= 10_000)) throw new ChainError("unknown", "Take out between 0.01% and all of it.");
    const { controller, pool, position } = await this.steer(positionId, opts);
    const liquidity = shareBps === 10_000 ? position.liquidity : (position.liquidity * BigInt(Math.round(shareBps))) / 10_000n;
    const expected = amountsForLiquidity(pool.sqrtPriceX96, position.tickLower, position.tickUpper, liquidity);
    const slip = BigInt(10_000 - (opts?.slippageBps ?? DEFAULT_SLIPPAGE_BPS));
    const [min0, min1] = [(expected.amount0 * slip) / 10_000n, (expected.amount1 * slip) / 10_000n];
    const out = await this.out(pool, opts);
    const terms = keccak256(coder.encode(["uint128", "uint256", "uint256", "bytes32"], [liquidity, min0, min1, String(await this.t.reading(this.read.outHash!(out)))]));
    const { deadline, signature } = await this.sign(controller, positionId, ACTION.decrease, terms);
    const relay = await this.t.relay();
    const args = { positionId, liquidity: liquidity.toString(), amount0Min: min0.toString(), amount1Min: min1.toString(), out, deadline, signature };
    const receipt = relay
      ? await this.relayed(opts, "decrease", () => relay.pockets("positionDecrease", args))
      : await this.sent(opts, () => this.t.writer(this.deployed).decrease!(positionId, liquidity, min0, min1, out, deadline, signature));
    const fees = this.netFees(receipt);
    const taken = this.events(receipt, "Decreased")[0]?.args;
    return { amount0: fees.amount0 + BigInt(taken?.amount0 ?? 0), amount1: fees.amount1 + BigInt(taken?.amount1 ?? 0) };
  }

  async give(positionId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const target = getAddress(to);
    if (await this.t.reading(this.read.controllerUsed!(target))) throw new ChainError("unknown", "That receive address has been used already: ask its holder for a fresh one.");
    const { controller } = await this.steer(positionId, opts);
    const { deadline, signature } = await this.sign(controller, positionId, ACTION.give, keccak256(coder.encode(["address"], [target])));
    const relay = await this.t.relay();
    if (relay) await this.relayed(opts, "give", () => relay.pockets("positionGive", { positionId, to: target, deadline, signature }));
    else await this.sent(opts, () => this.t.writer(this.deployed).give!(positionId, target, deadline, signature));
    this.found?.byPosition.delete(positionId);
  }

  async receiveAddress(opts?: ActionOptions): Promise<Address> {
    return (await this.nextController("receive", opts)).address as Address;
  }

  async takeOut(positionId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const target = getAddress(to);
    // The contract would take its own NFT back without a position for it: it would be stuck.
    if (sameAddress(target, this.deployed.address)) throw new ChainError("unknown", "Take it out to a wallet, not to the vault's positions contract.");
    const { controller } = await this.steer(positionId, opts);
    const { deadline, signature } = await this.sign(controller, positionId, ACTION.takeOut, keccak256(coder.encode(["address"], [target])));
    const relay = await this.t.relay();
    if (relay) await this.relayed(opts, "takeOut", () => relay.pockets("positionTakeOut", { positionId, to: target, deadline, signature }));
    else await this.sent(opts, () => this.t.writer(this.deployed).takeOut!(positionId, target, deadline, signature));
    this.found?.byPosition.delete(positionId);
  }

  async walletPositions(): Promise<WalletPosition[]> {
    if (!this.npm) return [];
    const account = await this.t.account();
    const pools = await this.pools();
    const count = Number(await this.t.reading(this.npm.balanceOf!(account)));
    const ids = await Promise.all(Array.from({ length: Math.min(count, 50) }, (_, i) => this.t.reading(this.npm!.tokenOfOwnerByIndex!(account, i)).then(BigInt)));
    const rows = await Promise.all(ids.map(async (tokenId) => ({ tokenId, p: await this.t.reading(this.npm!.positions!(tokenId)) })));
    return rows.flatMap(({ tokenId, p }) => {
      const pool = pools.find((x) => sameAddress(x.token0.underlying.address, String(p.token0)) && sameAddress(x.token1.underlying.address, String(p.token1)) && x.fee === Number(p.fee));
      return pool ? [{ tokenId, pool: pool.address, tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper), liquidity: BigInt(p.liquidity) }] : [];
    });
  }

  async deposit(tokenId: bigint, opts?: ActionOptions): Promise<number> {
    if (!this.deployed.uniswap) throw new ChainError("unknown", "There is no Uniswap here.");
    const account = await this.t.account();
    const controller = await this.nextController("open", opts);
    const npm = { address: this.deployed.uniswap.positionManager, abi: NPM_ABI };
    const receipt = await this.sent(opts, () => this.t.writer(npm).safeTransferFrom!(account, this.deployed.address, tokenId, coder.encode(["address"], [controller.address])));
    const positionId = Number(this.events(receipt, "Opened")[0]!.args.positionId);
    this.remember(positionId, controller);
    return positionId;
  }

  async settle(fundingId: number, opts?: ActionOptions): Promise<void> {
    const fd = await this.t.reading(this.read.fundingInfo!(fundingId));
    if (Number(fd.status) !== FUNDING_PENDING) return;
    const [d0, d1] = [await this.t.publicDecrypt([String(fd.unwrap0)], opts), await this.t.publicDecrypt([String(fd.unwrap1)], opts)];
    opts?.onStep?.("proving");
    const clear = (d: { abiEncodedClearValues: string }) => BigInt(coder.decode(["uint256"], d.abiEncodedClearValues)[0]);
    const args = { fundingId, clear0: clear(d0).toString(), proof0: d0.decryptionProof, clear1: clear(d1).toString(), proof1: d1.decryptionProof };
    const relay = await this.t.relay();
    if (relay) await this.relayed(opts, "settle", () => relay.pockets("positionSettle", args), false);
    else await this.sent(opts, () => this.t.writer(this.deployed).settle!(fundingId, args.clear0, args.proof0, args.clear1, args.proof1));
  }

  // --- internals ---

  /** The pools, with their live price and the pockets' tokens on each side. */
  private async pools(): Promise<PositionPool[]> {
    const tokens = this.side.pocketTokens();
    const byUnderlying = (a: string) => tokens.find((t) => sameAddress(t.underlying.address, a));
    const out: PositionPool[] = [];
    await Promise.all(
      this.deployed.pools.map(async (d, i) => {
        const [token0, token1] = [byUnderlying(d.token0), byUnderlying(d.token1)];
        if (!token0 || !token1) return;
        const pool = new Contract(d.address, POOL_ABI, this.t.readProvider);
        const [slot0, liquidity] = await Promise.all([this.t.reading(pool.slot0!()), this.t.reading(pool.liquidity!())]);
        out[i] = { address: d.address as Address, token0, token1, fee: d.fee, tickSpacing: TICK_SPACING[d.fee] ?? 60, sqrtPriceX96: BigInt(slot0.sqrtPriceX96), tick: Number(slot0.tick), liquidity: BigInt(liquidity) };
      }),
    );
    return out.filter(Boolean);
  }

  private async poolOrThrow(address: string): Promise<PositionPool> {
    const p = (await this.pools()).find((x) => sameAddress(x.address, address));
    if (!p) throw new ChainError("unknown", "The vault takes no positions in that pool.");
    return p;
  }

  /** A position as the page shows it: Uniswap's numbers, and its fundings still waiting. */
  private async position(positionId: number, pools: PositionPool[], pending?: Map<number, number[]>): Promise<SealedPosition> {
    const info = await this.t.reading(this.read.positionInfo!(positionId));
    const r = info.range;
    const pool = pools.find((x) => sameAddress(x.token0.underlying.address, String(r.token0)) && sameAddress(x.token1.underlying.address, String(r.token1)) && x.fee === Number(r.fee));
    const status = STATUS[Number(info.status)] as PositionStatus;
    const tokenId = BigInt(info.tokenId);
    let liquidity = 0n;
    let fees = { amount0: 0n, amount1: 0n };
    if (status === "open" && this.npm) {
      liquidity = BigInt((await this.t.reading(this.npm.positions!(tokenId))).liquidity);
      // What a collect would send now: the fees earned, Uniswap's own count (only the holder of the NFT may call it).
      const owed = await this.npm.collect!.staticCall({ tokenId, recipient: this.deployed.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }, { from: this.deployed.address }).catch(() => [0n, 0n]);
      fees = { amount0: BigInt(owed[0]), amount1: BigInt(owed[1]) };
    }
    const amounts = pool && liquidity > 0n ? amountsForLiquidity(pool.sqrtPriceX96, Number(r.tickLower), Number(r.tickUpper), liquidity) : { amount0: 0n, amount1: 0n };
    return {
      positionId,
      status,
      pool: (pool?.address ?? "") as Address,
      fee: Number(r.fee),
      tickLower: Number(r.tickLower),
      tickUpper: Number(r.tickUpper),
      tokenId: tokenId === 0n ? null : tokenId,
      liquidity,
      amount0: amounts.amount0,
      amount1: amounts.amount1,
      fees0: fees.amount0,
      fees1: fees.amount1,
      inRange: !!pool && pool.tick >= Number(r.tickLower) && pool.tick < Number(r.tickUpper),
      pending: status === "funding" || status === "open" ? ((pending ?? (await this.pending())).get(positionId) ?? []) : [],
      controller: String(info.controller) as Address,
    };
  }

  /** Fundings still waiting for their proofs, by position: from the `Funded` logs, read in spans
   *  from the last block looked at, and each one's status. */
  private fundingLogs: { block: number; byFunding: Map<number, number> } | null = null;
  private async pending(): Promise<Map<number, number[]>> {
    const latest = await this.t.readProvider.getBlockNumber();
    const seen = (this.fundingLogs ??= { block: (this.deployed.deployBlock ?? 0) - 1, byFunding: new Map() });
    for (let start = seen.block + 1; start <= latest; start += LOG_SPAN) {
      const logs = await this.read.queryFilter(this.read.filters.Funded!(), start, Math.min(latest, start + LOG_SPAN - 1));
      for (const l of logs) {
        const args = (l as unknown as { args: { fundingId: bigint; positionId: bigint } }).args;
        seen.byFunding.set(Number(args.fundingId), Number(args.positionId));
      }
      seen.block = Math.min(latest, start + LOG_SPAN - 1);
    }
    const out = new Map<number, number[]>();
    const waiting = [...seen.byFunding.entries()];
    const statuses = await Promise.all(waiting.map(async ([id]) => Number((await this.t.reading(this.read.fundingInfo!(id))).status)));
    waiting.forEach(([fundingId, positionId], i) => {
      if (statuses[i] !== FUNDING_PENDING) {
        seen.byFunding.delete(fundingId);
        return;
      }
      out.set(positionId, [...(out.get(positionId) ?? []), fundingId]);
    });
    return out;
  }

  /** The controller of the `index`-th position the wallet opened (`open`) or was given (`receive`). */
  private async controller(branch: "open" | "receive", index: number, opts?: ActionOptions): Promise<Wallet> {
    const signature = await this.side.pocketSignature(opts);
    return new Wallet(solidityPackedKeccak256(["bytes", "string"], [signature, `position:${this.deployed.address.toLowerCase()}:${branch}:${index}`]));
  }

  /** Walks the wallet's controllers, each branch until a few unused ones in a row: its positions, wherever it is. */
  private async scan(opts?: ActionOptions): Promise<NonNullable<EvmPositions["found"]>> {
    const account = await this.t.account();
    if (this.found?.account === account) return this.found;
    const found = { account, byPosition: new Map<number, Wallet>(), next: { open: 0, receive: 0 } };
    for (const branch of ["open", "receive"] as const) {
      let unused = 0;
      let first = -1;
      for (let i = 0; unused < LOOK_AHEAD; i++) {
        const c = await this.controller(branch, i, opts);
        const [used, plusOne] = await Promise.all([this.t.reading(this.read.controllerUsed!(c.address)), this.t.reading(this.read.positionOf!(c.address))]);
        if (!used) {
          if (first < 0) first = i;
          unused++;
          continue;
        }
        unused = 0;
        first = -1;
        if (Number(plusOne) > 0) found.byPosition.set(Number(plusOne) - 1, c);
      }
      found.next[branch] = first;
    }
    this.found = found;
    return found;
  }

  private async myIds(opts?: ActionOptions): Promise<number[]> {
    const found = await this.scan(opts);
    // Positions given to a receive address after the scan: look again past the last one.
    for (const branch of ["receive"] as const) {
      for (let i = found.next[branch]; i < found.next[branch] + LOOK_AHEAD; i++) {
        const c = await this.controller(branch, i, opts);
        const plusOne = Number(await this.t.reading(this.read.positionOf!(c.address)));
        if (plusOne > 0) {
          found.byPosition.set(plusOne - 1, c);
          found.next[branch] = i + 1;
        }
      }
    }
    return [...found.byPosition.keys()];
  }

  private async nextController(branch: "open" | "receive", opts?: ActionOptions): Promise<Wallet> {
    const found = await this.scan(opts);
    for (let i = found.next[branch]; ; i++) {
      const c = await this.controller(branch, i, opts);
      if (!(await this.t.reading(this.read.controllerUsed!(c.address)))) {
        found.next[branch] = i;
        return c;
      }
    }
  }

  /** A controller just put to use: the next one looked for is past it, as the chain now says. */
  private remember(positionId: number, controller: Wallet) {
    this.found?.byPosition.set(positionId, controller);
  }

  /** The wallet's controller of `positionId`, the position and its pool. */
  private async steer(positionId: number, opts?: ActionOptions) {
    await this.myIds(opts);
    const controller = this.found?.byPosition.get(positionId);
    if (!controller) throw new ChainError("not-yours", "This position is not yours.");
    const position = await this.position(positionId, await this.pools());
    if (position.status !== "open") throw new ChainError("unknown", "This position is not open.");
    const onChain = String(position.controller);
    if (!sameAddress(onChain, controller.address)) throw new ChainError("not-yours", "This position is not yours any more.");
    return { controller, position, pool: await this.poolOrThrow(position.pool) };
  }

  private async sign(controller: Wallet, positionId: number, action: number, terms: string) {
    const block = await this.t.readProvider.getBlock("latest");
    const deadline = (block?.timestamp ?? Math.floor(Date.now() / 1000)) + ACT_DEADLINE;
    const digest = String(await this.t.reading(this.read.actDigest!(positionId, action, terms, deadline)));
    return { deadline, signature: controller.signingKey.sign(digest).serialized };
  }

  /** The two pockets of a pool's tokens, opened when the wallet has none. */
  private async pocketsFor(p: PositionPool) {
    const [p0, p1] = [this.side.pocketsOf(p.token0.underlying.address), this.side.pocketsOf(p.token1.underlying.address)];
    if (!p0 || !p1) throw new ChainError("unknown", "One of this pool's tokens has no pockets here.");
    return [p0, p1] as const;
  }

  /** Where tokens coming out go: the wallet's own pockets, among decoys. */
  private async out(p: PositionPool, opts?: PositionOptions): Promise<PositionOutArgs> {
    const account = await this.t.account();
    const [pockets0, pockets1] = await this.pocketsFor(p);
    const [id0, id1] = [await pockets0.ensureMine(opts), await pockets1.ensureMine(opts)];
    const [set0, set1] = [await pockets0.setFor(id0, opts), await pockets1.setFor(id1, opts)];
    const relay = await this.t.relay();
    const values = await this.t.encrypt(this.deployed.address, account, (b) => b.add32(id0).add32(id1), "where it goes", opts, relay?.address ?? account);
    return { set0, set1, target0: hex(values.handles[0]!), target1: hex(values.handles[1]!), inputProof: hex(values.inputProof) };
  }

  /** A funding's inputs: the amounts and targets, then both pocket keys bound to its terms. */
  private async funding(p: PositionPool, tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint, opts: PositionOptions | undefined, bind: (f: PositionFundsArgs) => Promise<unknown>) {
    const account = await this.t.account();
    const [pockets0, pockets1] = await this.pocketsFor(p);
    const [id0, id1] = [await pockets0.ensureMine(opts), await pockets1.ensureMine(opts)];
    const [key0, key1] = [await pockets0.pocketKey(opts), await pockets1.pocketKey(opts)];
    const [set0, set1] = [await pockets0.setFor(id0, opts), await pockets1.setFor(id1, opts)];
    // What Uniswap should take at today's price, less the slippage allowed.
    const liquidity = liquidityForAmounts(p.sqrtPriceX96, tickLower, tickUpper, amount0 * p.token0.rate, amount1 * p.token1.rate);
    if (liquidity === 0n) throw new ChainError("unknown", "At today's price, this range needs the other token: put some of both in.");
    const used = amountsForLiquidity(p.sqrtPriceX96, tickLower, tickUpper, liquidity);
    const slip = BigInt(10_000 - (opts?.slippageBps ?? DEFAULT_SLIPPAGE_BPS));
    const relay = await this.t.relay();
    const sender = relay?.address ?? account;
    const block = await this.t.readProvider.getBlock("latest");
    const values = await this.t.encrypt(this.deployed.address, account, (b) => b.add64(amount0).add64(amount1).add32(id0).add32(id1), "the amounts", opts, sender);
    const funds: PositionFundsArgs = {
      set0,
      set1,
      amount0: hex(values.handles[0]!),
      amount1: hex(values.handles[1]!),
      target0: hex(values.handles[2]!),
      target1: hex(values.handles[3]!),
      inputProof: hex(values.inputProof),
      amount0Min: ((used.amount0 * slip) / 10_000n).toString(),
      amount1Min: ((used.amount1 * slip) / 10_000n).toString(),
      deadline: (block?.timestamp ?? Math.floor(Date.now() / 1000)) + FUNDING_DEADLINE,
    };
    const terms = BigInt(String(await bind(funds)));
    const bound = await this.t.encrypt(this.deployed.address, account, (b) => b.add256(key0 ^ terms).add256(key1 ^ terms), "the pocket keys", opts, sender);
    return { funds, keys: { boundKey0: hex(bound.handles[0]!), boundKey1: hex(bound.handles[1]!), keyProof: hex(bound.inputProof) } };
  }

  /** Settles a funding and says how it went: `not-yours` when a pocket did not pay, `missed` when Uniswap refused. */
  private async settleOrThrow(fundingId: number, opts?: ActionOptions): Promise<void> {
    await this.settle(fundingId, opts);
    await this.caughtUp();
    const logs = await this.read.queryFilter(this.read.filters.Settled!(fundingId), this.lastBlock - 5);
    const settled = (logs[0] as unknown as { args: { ok: boolean } } | undefined)?.args;
    if (settled?.ok) return;
    const fd = await this.t.reading(this.read.fundingInfo!(fundingId));
    const [d0, d1] = [await this.t.publicDecrypt([String(fd.unwrap0)], opts), await this.t.publicDecrypt([String(fd.unwrap1)], opts)];
    const paid = [d0, d1].some((d) => BigInt(coder.decode(["uint256"], d.abiEncodedClearValues)[0]) > 0n);
    if (!paid) throw new ChainError("not-yours", "One of your pockets does not cover its amount. Nothing moved.");
    throw new ChainError("missed", "Uniswap refused the deposit (the price moved, or it took too long): everything went back to your pockets.");
  }

  /** What a collect sent into the pockets: the fees, the vault's share taken. */
  private netFees(receipt: ContractTransactionReceipt): { amount0: bigint; amount1: bigint } {
    const c = this.events(receipt, "Collected")[0]?.args;
    if (!c) return { amount0: 0n, amount1: 0n };
    return { amount0: BigInt(c.amount0) - BigInt(c.fee0), amount1: BigInt(c.amount1) - BigInt(c.fee1) };
  }

  /** Test networks: mints a slice of the pool's token0, sells it and buys it back, from the wallet. */
  private async roundTrip(poolAddress: Address, opts?: ActionOptions): Promise<void> {
    const p = await this.poolOrThrow(poolAddress);
    const account = await this.t.account();
    const uniswap = this.deployed.uniswap!;
    const v1 = (this.deployed.routerVersion ?? 2) === 1;
    const router = { address: uniswap.swapRouter, abi: v1 ? ROUTER_V1_ABI : ROUTER_V2_ABI };
    const swap = async (tokenIn: string, tokenOut: string, amountIn: bigint) => {
      const token = { address: tokenIn, abi: ERC20_ABI };
      const reader = new Contract(tokenIn, ERC20_ABI, this.t.readProvider);
      if (BigInt(await this.t.reading(reader.allowance!(account, uniswap.swapRouter))) < amountIn) {
        await this.sent(opts, () => this.t.writer(token).approve!(uniswap.swapRouter, amountIn));
      }
      const block = await this.t.readProvider.getBlock("latest");
      const params = v1
        ? { tokenIn, tokenOut, fee: p.fee, recipient: account, deadline: (block?.timestamp ?? 0) + 600, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
        : { tokenIn, tokenOut, fee: p.fee, recipient: account, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 };
      await this.sent(opts, () => this.t.writer(router).exactInputSingle!(params));
    };
    const [a, b] = [p.token0.underlying.address, p.token1.underlying.address];
    const token0 = new Contract(a, ERC20_ABI, this.t.readProvider);
    const token1 = new Contract(b, ERC20_ABI, this.t.readProvider);
    // 2% of what the pool holds of token0: enough to move the price, and back.
    const amountIn = BigInt(await this.t.reading(token0.balanceOf!(p.address))) / 50n;
    if (amountIn === 0n) throw new ChainError("unknown", "This pool holds nothing to trade.");
    const held = BigInt(await this.t.reading(token0.balanceOf!(account)));
    if (held < amountIn) await this.sent(opts, () => this.t.writer({ address: a, abi: ERC20_ABI }).mint!(account, amountIn - held));
    const before1 = BigInt(await this.t.reading(token1.balanceOf!(account)));
    await swap(a, b, amountIn);
    await this.caughtUp();
    const got = BigInt(await this.t.reading(token1.balanceOf!(account))) - before1;
    if (got > 0n) await swap(b, a, got);
  }

  private events(receipt: ContractTransactionReceipt, name: string) {
    return receipt.logs
      .filter((l) => sameAddress(l.address, this.deployed.address))
      .map((l) => {
        try {
          return this.read.interface.parseLog(l as never);
        } catch {
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e?.name === name);
  }

  private async relayed(opts: ActionOptions | undefined, call: string, sendIt: () => Promise<string>, announce = true) {
    return this.mined(await this.t.relayed(opts, call, sendIt, announce));
  }

  private async sent(opts: ActionOptions | undefined, call: Parameters<EvmPocketsTools["send"]>[1]) {
    return this.mined(await this.t.send(opts, call));
  }

  private mined<R extends { blockNumber: number }>(receipt: R): R {
    this.lastBlock = Math.max(this.lastBlock, receipt.blockNumber);
    return receipt;
  }

  /** A public RPC can lag a block or two behind the transaction it just confirmed: wait for it (30 s at most). */
  private async caughtUp(): Promise<void> {
    for (let i = 0; i < 15 && (await this.t.readProvider.getBlockNumber()) < this.lastBlock; i++) await new Promise((r) => setTimeout(r, 2000));
  }
}
