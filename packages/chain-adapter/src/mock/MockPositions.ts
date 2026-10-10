import { ChainError, type ActionOptions, type Address } from "../types";
import { DEFAULT_POCKET_DECOYS, pocketSet } from "../pockets";
import { amountsForLiquidity, fullRange, liquidityForAmounts, sqrtRatioAtTick, TICK_SPACING, tickForPrice } from "../liquidity";
import type { PocketToken, PositionOptions, PositionPool, PositionsAdapter, PositionsInfo, PositionStatus, SealedPosition, WalletPosition } from "../vault";

/** The positions contract in the demo: it holds every position's Uniswap NFT. */
export const MOCK_POSITIONS: Address = "0x0000000000000000000000000000000000001b05";
const MOCK_POSITION_MANAGER: Address = "0x1238536071E1c677A632429e3655c799b22cDA52";
const FEE_BPS = 500n;
const MAX_SET = 5;

/** A pocket, as the mock vault keeps it. */
interface MockPocket {
  owner: Address;
  balance: bigint;
}

/** What the mock positions borrow from the mock vault: the wallet, the clock, and the pockets. */
export interface MockPositionsHost {
  account(): Address | null;
  now(): number;
  send(opts: ActionOptions | undefined, call: string): Promise<void>;
  publish(opts: ActionOptions | undefined, call: string): Promise<void>;
  /** Every token with pockets, and its pockets. */
  books(): { token: PocketToken; list: MockPocket[] }[];
}

interface MockPool {
  address: Address;
  token0: PocketToken;
  token1: PocketToken;
  fee: number;
  tick: number;
  /** The market's own liquidity, which takes its share of the fees. */
  depth: bigint;
}

interface MockPosition {
  positionId: number;
  /** On a real chain only the controller's signature says so. */
  owner: Address;
  controller: Address;
  status: PositionStatus;
  pool: Address;
  tickLower: number;
  tickUpper: number;
  tokenId: bigint | null;
  liquidity: bigint;
  fees0: bigint;
  fees1: bigint;
}

/** The pools of the demo, as the deploy opens them on Sepolia: whole quote per whole base. */
const PLANS = [
  { base: "WETH", quote: "USDC", fee: 3000, price: 2500 },
  { base: "ZAMA", quote: "USDC", fee: 10000, price: 0.05 },
  { base: "USDT", quote: "USDC", fee: 500, price: 1 },
];

/** Trading fees a position in range earns per mock second, as a share of what it holds: fast, so the demo shows them. */
const FEES_PER_SECOND = 0.00002;

const randomAddress = (): Address => `0x${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
const revert = (reason: string) => new ChainError("reverted", `The vault refused: ${reason}.`, reason);

/**
 * Liquidity positions in memory, with the contract's rules: both sides are paid or neither, what
 * Uniswap does not take goes back to the pockets, only the controller acts. The pools trade on
 * their own: the price wanders a little and the positions in range earn fees as mock time goes by,
 * and the night shift holds a position of its own so the list is never empty.
 */
export class MockPositions implements PositionsAdapter {
  private readonly pools: MockPool[] = [];
  private readonly list: MockPosition[] = [];
  private lastTick: number;
  private nextTokenId = 4100n;
  private receive: { owner: Address; address: Address } | null = null;
  /** Uniswap positions the demo wallet holds itself, outside the vault. */
  private readonly outside = new Map<bigint, { owner: Address; pool: Address; tickLower: number; tickUpper: number; liquidity: bigint }>();

  readonly trade: (pool: Address, opts?: ActionOptions) => Promise<void>;

  constructor(
    private readonly host: MockPositionsHost,
    nightShift: Address,
    you: Address,
  ) {
    this.lastTick = host.now();
    const tokens = host.books().map((b) => b.token);
    for (const [i, plan] of PLANS.entries()) {
      const base = tokens.find((t) => t.underlying.symbol === plan.base);
      const quote = tokens.find((t) => t.underlying.symbol === plan.quote);
      if (!base || !quote) continue;
      const baseFirst = BigInt(base.underlying.address) < BigInt(quote.underlying.address);
      const [token0, token1] = baseFirst ? [base, quote] : [quote, base];
      const price = baseFirst ? plan.price : 1 / plan.price;
      this.pools.push({
        address: `0x00000000000000000000000000000000000f00${(i + 1).toString(16).padStart(2, "0")}` as Address,
        token0,
        token1,
        fee: plan.fee,
        tick: tickForPrice(price, token0.underlying.decimals, token1.underlying.decimals, 100),
        depth: 10n ** 22n,
      });
    }
    const first = this.pools[0];
    if (first) {
      // The night shift's own position, and one the demo wallet holds outside the vault.
      const around = this.around(first, 20);
      this.list.push({ positionId: 0, owner: nightShift, controller: randomAddress(), status: "open", pool: first.address, ...around, tokenId: this.nextTokenId++, liquidity: 10n ** 15n, fees0: 0n, fees1: 0n });
      this.outside.set(this.nextTokenId++, { owner: you, pool: first.address, ...this.around(first, 10), liquidity: 2n * 10n ** 13n });
    }
    this.trade = async (pool, opts) => {
      const p = this.pool(pool);
      await this.host.send(opts, "exactInputSingle");
      await this.host.send(opts, "exactInputSingle");
      this.tick();
      // A big round trip: the price ends where it started, the positions in range earn a trade's fees.
      for (const pos of this.list) {
        if (pos.pool !== p.address || pos.status !== "open" || !this.inRange(pos, p)) continue;
        const { amount0, amount1 } = this.amounts(pos, p);
        pos.fees0 += (amount0 * BigInt(p.fee)) / 50_000n;
        pos.fees1 += (amount1 * BigInt(p.fee)) / 50_000n;
      }
    };
  }

  async info(): Promise<PositionsInfo> {
    this.tick();
    return {
      address: MOCK_POSITIONS,
      positionManager: MOCK_POSITION_MANAGER,
      feeBps: Number(FEE_BPS),
      count: this.list.length,
      pools: this.pools.map((p) => this.poolView(p)),
      relayer: "0x000000000000000000000000000000000000a11e",
    };
  }

  async all(): Promise<SealedPosition[]> {
    this.tick();
    return this.list.map((p) => this.view(p)).reverse();
  }

  async mine(opts?: ActionOptions): Promise<SealedPosition[]> {
    const me = this.signer();
    opts?.onStep?.("wallet");
    this.tick();
    return this.list.filter((p) => p.owner === me && (p.status === "open" || p.status === "funding")).map((p) => this.view(p)).reverse();
  }

  async open(pool: Address, tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint, opts?: PositionOptions): Promise<number> {
    const me = this.signer();
    const p = this.pool(pool);
    const spacing = TICK_SPACING[p.fee]!;
    if (tickLower >= tickUpper || tickLower % spacing !== 0 || tickUpper % spacing !== 0) throw revert("BadRange");
    const positionId = this.list.length;
    const pos: MockPosition = { positionId, owner: me, controller: randomAddress(), status: "funding", pool: p.address, tickLower, tickUpper, tokenId: null, liquidity: 0n, fees0: 0n, fees1: 0n };
    this.list.push(pos);
    await this.fund(pos, p, amount0, amount1, opts);
    if (pos.status === "failed") throw new ChainError("not-yours", "One of your pockets does not cover its amount. Nothing moved.");
    return positionId;
  }

  async add(positionId: number, amount0: bigint, amount1: bigint, opts?: PositionOptions): Promise<void> {
    const pos = this.mineOrThrow(positionId);
    if (pos.status !== "open") throw revert("NotOpen");
    const before = pos.liquidity;
    await this.fund(pos, this.pool(pos.pool), amount0, amount1, opts);
    if (pos.liquidity === before) throw new ChainError("not-yours", "One of your pockets does not cover its amount. Nothing moved.");
  }

  async collect(positionId: number, opts?: PositionOptions): Promise<{ amount0: bigint; amount1: bigint }> {
    const pos = this.mineOrThrow(positionId);
    if (pos.status !== "open") throw revert("NotOpen");
    const p = this.pool(pos.pool);
    this.sets(pos, p, opts);
    opts?.onStep?.("wallet");
    opts?.onStep?.("encrypting");
    await this.host.send(opts, "collect");
    this.tick();
    const net = this.takeFees(pos);
    this.payOut(p, net.amount0, net.amount1);
    return net;
  }

  async remove(positionId: number, shareBps: number, opts?: PositionOptions): Promise<{ amount0: bigint; amount1: bigint }> {
    const pos = this.mineOrThrow(positionId);
    if (pos.status !== "open") throw revert("NotOpen");
    if (!(shareBps > 0 && shareBps <= 10_000)) throw revert("BadShare");
    const p = this.pool(pos.pool);
    this.sets(pos, p, opts);
    opts?.onStep?.("wallet");
    opts?.onStep?.("encrypting");
    await this.host.send(opts, "decrease");
    this.tick();
    const fees = this.takeFees(pos);
    const liquidity = shareBps === 10_000 ? pos.liquidity : (pos.liquidity * BigInt(shareBps)) / 10_000n;
    const { amount0, amount1 } = amountsForLiquidity(sqrtRatioAtTick(p.tick), pos.tickLower, pos.tickUpper, liquidity);
    pos.liquidity -= liquidity;
    if (pos.liquidity === 0n) pos.status = "closed";
    const out = { amount0: amount0 + fees.amount0, amount1: amount1 + fees.amount1 };
    this.payOut(p, out.amount0, out.amount1);
    return out;
  }

  async give(positionId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const pos = this.mineOrThrow(positionId);
    if (pos.status !== "open") throw revert("NotOpen");
    if (this.list.some((p) => p.controller.toLowerCase() === to.toLowerCase())) throw revert("ControllerUsed");
    opts?.onStep?.("wallet");
    await this.host.send(opts, "give");
    pos.controller = to;
    // A receive address of the demo wallet's comes back to it; any other goes to a stranger.
    pos.owner = this.receive?.address.toLowerCase() === to.toLowerCase() ? this.receive.owner : randomAddress();
    if (this.receive?.address.toLowerCase() === to.toLowerCase()) this.receive = null;
  }

  async receiveAddress(opts?: ActionOptions): Promise<Address> {
    const me = this.signer();
    opts?.onStep?.("wallet");
    if (this.receive?.owner !== me) this.receive = { owner: me, address: randomAddress() };
    return this.receive.address;
  }

  async takeOut(positionId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const pos = this.mineOrThrow(positionId);
    if (pos.status !== "open") throw revert("NotOpen");
    opts?.onStep?.("wallet");
    await this.host.send(opts, "takeOut");
    pos.status = "out";
    if (to.toLowerCase() === this.signer().toLowerCase() && pos.tokenId !== null) {
      this.outside.set(pos.tokenId, { owner: this.signer(), pool: pos.pool, tickLower: pos.tickLower, tickUpper: pos.tickUpper, liquidity: pos.liquidity });
    }
  }

  async walletPositions(): Promise<WalletPosition[]> {
    const me = this.host.account();
    return [...this.outside.entries()].filter(([, w]) => w.owner === me).map(([tokenId, w]) => ({ tokenId, pool: w.pool, tickLower: w.tickLower, tickUpper: w.tickUpper, liquidity: w.liquidity }));
  }

  async deposit(tokenId: bigint, opts?: ActionOptions): Promise<number> {
    const me = this.signer();
    const w = this.outside.get(tokenId);
    if (!w || w.owner !== me) throw revert("NotYourPosition");
    opts?.onStep?.("wallet");
    await this.host.send(opts, "safeTransferFrom");
    this.outside.delete(tokenId);
    const positionId = this.list.length;
    this.list.push({ positionId, owner: me, controller: randomAddress(), status: "open", pool: w.pool, tickLower: w.tickLower, tickUpper: w.tickUpper, tokenId, liquidity: w.liquidity, fees0: 0n, fees1: 0n });
    return positionId;
  }

  async settle(_fundingId: number, _opts?: ActionOptions): Promise<void> {
    throw revert("FundingNotPending");
  }

  // --- internals ---

  private signer(): Address {
    const me = this.host.account();
    if (!me) throw new ChainError("not-connected", "No account connected.");
    return me;
  }

  private pool(address: Address): MockPool {
    const p = this.pools.find((x) => x.address.toLowerCase() === address.toLowerCase());
    if (!p) throw revert("NotATokenHere");
    return p;
  }

  private mineOrThrow(positionId: number): MockPosition {
    const pos = this.list[positionId];
    if (!pos) throw revert("NotAPosition");
    if (pos.owner !== this.signer()) throw revert("NotController");
    return pos;
  }

  private around(p: MockPool, pct: number): { tickLower: number; tickUpper: number } {
    const spacing = TICK_SPACING[p.fee]!;
    const width = Math.round(Math.log(1 + pct / 100) / Math.log(1.0001) / spacing) * spacing;
    const base = Math.round(p.tick / spacing) * spacing;
    return { tickLower: base - width, tickUpper: base + width };
  }

  private book(token: PocketToken) {
    const b = this.host.books().find((x) => x.token.symbol === token.symbol);
    if (!b) throw revert("NotATokenHere");
    return b;
  }

  /** The wallet's pocket of `token`, opened when it has none. */
  private pocketOf(token: PocketToken): MockPocket {
    const me = this.signer();
    const { list } = this.book(token);
    let pocket = list.find((x) => x.owner === me);
    if (!pocket) {
      pocket = { owner: me, balance: 0n };
      list.push(pocket);
    }
    return pocket;
  }

  /** The sets an action names: checked as the contract would, decoys picked at random. */
  private sets(_pos: MockPosition, p: MockPool, opts?: PositionOptions) {
    for (const token of [p.token0, p.token1]) {
      const { list } = this.book(token);
      const real = list.indexOf(this.pocketOf(token));
      pocketSet(real, list.length, opts?.decoys ?? DEFAULT_POCKET_DECOYS, MAX_SET);
    }
  }

  /** Both sides out of the pockets or neither; what Uniswap takes goes in, the rest goes back. */
  private async fund(pos: MockPosition, p: MockPool, amount0: bigint, amount1: bigint, opts?: PositionOptions) {
    const pocket0 = this.pocketOf(p.token0);
    const pocket1 = this.pocketOf(p.token1);
    this.sets(pos, p, opts);
    opts?.onStep?.("wallet");
    opts?.onStep?.("encrypting");
    await this.host.send(opts, pos.status === "funding" ? "open" : "add");
    const paid = pocket0.balance >= amount0 && pocket1.balance >= amount1;
    await this.host.publish(opts, "settle");
    if (!paid || (amount0 === 0n && amount1 === 0n)) {
      if (pos.status === "funding") pos.status = "failed";
      return;
    }
    this.tick();
    const sqrtP = sqrtRatioAtTick(p.tick);
    const in0 = amount0 * p.token0.rate;
    const in1 = amount1 * p.token1.rate;
    const liquidity = liquidityForAmounts(sqrtP, pos.tickLower, pos.tickUpper, in0, in1);
    if (liquidity === 0n) {
      if (pos.status === "funding") pos.status = "failed";
      throw new ChainError("missed", "Uniswap took nothing at this price: everything went back to your pockets.");
    }
    const used = amountsForLiquidity(sqrtP, pos.tickLower, pos.tickUpper, liquidity);
    // Uniswap rounds what it takes up; the pockets get back whole units of what is left.
    pocket0.balance -= amount0 - (in0 - used.amount0) / p.token0.rate;
    pocket1.balance -= amount1 - (in1 - used.amount1) / p.token1.rate;
    pos.liquidity += liquidity;
    if (pos.status === "funding") {
      pos.status = "open";
      pos.tokenId = this.nextTokenId++;
    }
  }

  /** The fees earned so far, the vault's share taken. */
  private takeFees(pos: MockPosition): { amount0: bigint; amount1: bigint } {
    const out = { amount0: pos.fees0 - (pos.fees0 * FEE_BPS) / 10_000n, amount1: pos.fees1 - (pos.fees1 * FEE_BPS) / 10_000n };
    pos.fees0 = 0n;
    pos.fees1 = 0n;
    return out;
  }

  /** Into the wallet's pockets, in whole confidential units. */
  private payOut(p: MockPool, amount0: bigint, amount1: bigint) {
    this.pocketOf(p.token0).balance += amount0 / p.token0.rate;
    this.pocketOf(p.token1).balance += amount1 / p.token1.rate;
  }

  private inRange(pos: Pick<MockPosition, "tickLower" | "tickUpper">, p: MockPool): boolean {
    return p.tick >= pos.tickLower && p.tick < pos.tickUpper;
  }

  private amounts(pos: MockPosition, p: MockPool) {
    return amountsForLiquidity(sqrtRatioAtTick(p.tick), pos.tickLower, pos.tickUpper, pos.liquidity);
  }

  /** Mock time goes by: prices wander a few ticks, positions in range earn fees. */
  private tick() {
    const now = this.host.now();
    const seconds = Math.min(3600, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    if (seconds <= 0) return;
    for (const p of this.pools) {
      p.tick += Math.round((Math.random() - 0.5) * 2 * Math.min(60, seconds) * (TICK_SPACING[p.fee]! / 10));
      const { tickLower, tickUpper } = fullRange(p.fee);
      p.tick = Math.max(tickLower + 1, Math.min(tickUpper - 1, p.tick));
    }
    const rate = BigInt(Math.round(seconds * FEES_PER_SECOND * 1e9));
    for (const pos of this.list) {
      const p = this.pool(pos.pool);
      if (pos.status !== "open" || !this.inRange(pos, p)) continue;
      const { amount0, amount1 } = this.amounts(pos, p);
      pos.fees0 += (amount0 * rate) / 1_000_000_000n;
      pos.fees1 += (amount1 * rate) / 1_000_000_000n;
    }
  }

  private poolView(p: MockPool): PositionPool {
    return { address: p.address, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: TICK_SPACING[p.fee]!, sqrtPriceX96: sqrtRatioAtTick(p.tick), tick: p.tick, liquidity: p.depth };
  }

  private view(pos: MockPosition): SealedPosition {
    const p = this.pool(pos.pool);
    const { amount0, amount1 } = pos.status === "open" ? this.amounts(pos, p) : { amount0: 0n, amount1: 0n };
    return {
      positionId: pos.positionId,
      status: pos.status,
      pool: pos.pool,
      fee: p.fee,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      tokenId: pos.tokenId,
      liquidity: pos.liquidity,
      amount0,
      amount1,
      fees0: pos.fees0,
      fees1: pos.fees1,
      inRange: this.inRange(pos, p),
      pending: [],
      controller: pos.controller,
    };
  }
}
