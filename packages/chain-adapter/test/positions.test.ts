import { describe, expect, it } from "vitest";
import {
  amountsForLiquidity,
  ChainError,
  fullRange,
  liquidityForAmounts,
  MockAdapter,
  pairedAmount,
  priceAtTick,
  priceOf,
  rangeAround,
  sqrtRatioAtTick,
  TICK_SPACING,
  tickForPrice,
} from "../src";

const USD = 1_000_000n;
const FRESH = "0x000000000000000000000000000000000000f00d";

describe("liquidity math", () => {
  // 1 WETH (18 decimals) = 2,000 USDC (6), USDC as token0: WETH's wei per USDC's unit.
  const tick = tickForPrice(1 / 2000, 6, 18, 3000);
  const sqrtP = sqrtRatioAtTick(tick);

  it("finds the tick of a price and the price of a tick, both ways", () => {
    // 1 WETH (18 decimals) = 2,000 USDC (6): USDC is token0, so the price is WETH per USDC.
    const t = tickForPrice(1 / 2000, 6, 18, 3000);
    expect(t % 60).toBe(0);
    expect(priceAtTick(t, 6, 18)).toBeCloseTo(1 / 2000, 5);
    expect(priceOf(sqrtRatioAtTick(t), 6, 18)).toBeCloseTo(priceAtTick(t, 6, 18), 8);
    expect(tickForPrice(0, 6, 18, 3000)).toBe(fullRange(3000).tickLower);
  });

  it("buys liquidity with two amounts and gives them back, rounding down", () => {
    const { tickLower, tickUpper } = rangeAround(tick, 3000, 10);
    const amount0 = 2_000n * USD;
    const amount1 = 10n ** 18n;
    const liquidity = liquidityForAmounts(sqrtP, tickLower, tickUpper, amount0, amount1);
    expect(liquidity).toBeGreaterThan(0n);
    const back = amountsForLiquidity(sqrtP, tickLower, tickUpper, liquidity);
    expect(back.amount0).toBeLessThanOrEqual(amount0);
    expect(back.amount1).toBeLessThanOrEqual(amount1);
    // One side is used up, to rounding.
    expect(amount0 - back.amount0 < 10n || amount1 - back.amount1 < 10n ** 9n).toBe(true);
  });

  it("pairs an amount with what the other side needs, and says when a side is not taken", () => {
    const { tickLower, tickUpper } = rangeAround(tick, 3000, 10);
    const amount1 = pairedAmount(sqrtP, tickLower, tickUpper, 0, 2_000n * USD)!;
    const liquidity = liquidityForAmounts(sqrtP, tickLower, tickUpper, 2_000n * USD, amount1);
    const used = amountsForLiquidity(sqrtP, tickLower, tickUpper, liquidity);
    expect(Number(2_000n * USD - used.amount0)).toBeLessThan(Number(USD / 100n));
    // A range wholly above the price takes token0 only.
    const above = { lower: tick + 600, upper: tick + 1200 };
    expect(pairedAmount(sqrtP, above.lower, above.upper, 0, USD)).toBe(0n);
    expect(pairedAmount(sqrtP, above.lower, above.upper, 1, USD)).toBe(null);
  });

  it("keeps ranges on the fee tier's spacing, and a full range at the edges", () => {
    for (const fee of [500, 3000, 10000]) {
      const r = rangeAround(tick, fee, 5);
      expect(Math.abs(r.tickLower % TICK_SPACING[fee]!)).toBe(0);
      expect(Math.abs(r.tickUpper % TICK_SPACING[fee]!)).toBe(0);
      expect(r.tickLower).toBeLessThan(tick);
      expect(r.tickUpper).toBeGreaterThan(tick);
      expect(rangeAround(tick, fee, 0)).toEqual(fullRange(fee));
    }
  });
});

const fresh = async () => {
  let now = 1_790_000_000_000;
  const chain = new MockAdapter({ latency: 0, now: () => now });
  await chain.connect();
  const vault = chain.vault();
  return { chain, vault, positions: vault.positions()!, tick: (ms: number) => (now += ms) };
};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof ChainError ? (e.reason ?? e.code) : String(e);
  }
  return "ok";
};

describe("MockPositions", () => {
  /** A wallet with cUSDC and cWETH in its pockets. */
  const funded = async () => {
    const f = await fresh();
    const usdc = f.vault.pockets("cUSDC")!;
    const weth = f.vault.pockets("cWETH")!;
    await usdc.open();
    await usdc.shield(100n * USD);
    await usdc.deposit(100n * USD);
    await weth.open();
    await weth.faucet();
    await weth.shield(USD);
    await weth.deposit(USD);
    const pool = (await f.positions.info()).pools.find((p) => p.token1.symbol === "cWETH" || p.token0.symbol === "cWETH")!;
    return { ...f, usdc, weth, pool };
  };

  it("lists the pools between the pockets' tokens, and the night shift's position", async () => {
    const { positions } = await fresh();
    const info = await positions.info();
    expect(info.pools.map((p) => `${p.token0.symbol}/${p.token1.symbol}`)).toContain("cUSDC/cWETH");
    expect(info.feeBps).toBe(500);
    expect((await positions.all()).length).toBe(1);
    expect(await positions.mine()).toEqual([]);
  });

  it("opens a position out of both pockets and gives the leftovers back", async () => {
    const { positions, usdc, weth, pool } = await funded();
    const { tickLower, tickUpper } = rangeAround(pool.tick, pool.fee, 10);
    const id = await positions.open(pool.address, tickLower, tickUpper, 50n * USD, USD / 50n);
    const [mine] = await positions.mine();
    expect(mine!.positionId).toBe(id);
    expect(mine!.status).toBe("open");
    expect(mine!.inRange).toBe(true);
    expect(mine!.liquidity).toBeGreaterThan(0n);
    // One side used up, the other given back in part.
    const [left0, left1] = [await usdc.balance(), await weth.balance()];
    expect(left0 >= 50n * USD && left1 >= USD - USD / 50n).toBe(true);
    expect(left0 > 50n * USD || left1 > USD - USD / 50n).toBe(true);
  });

  it("takes nothing when a pocket is short", async () => {
    const { positions, usdc, pool } = await funded();
    const { tickLower, tickUpper } = rangeAround(pool.tick, pool.fee, 10);
    expect(await code(positions.open(pool.address, tickLower, tickUpper, 9_000n * USD, USD))).toBe("not-yours");
    expect(await usdc.balance()).toBe(100n * USD);
    expect(await positions.mine()).toEqual([]);
  });

  it("earns fees in range as time goes by, collects them into the pockets less the vault's share, and closes", async () => {
    const { positions, usdc, pool, tick } = await funded();
    const { tickLower, tickUpper } = rangeAround(pool.tick, pool.fee, 50);
    const id = await positions.open(pool.address, tickLower, tickUpper, 50n * USD, USD / 50n);
    await positions.trade!(pool.address);
    tick(60_000);
    const [earning] = await positions.mine();
    expect(earning!.fees0 + earning!.fees1).toBeGreaterThan(0n);
    const before = await usdc.balance();
    const got = await positions.collect(id);
    expect(got.amount0 + got.amount1).toBeGreaterThan(0n);
    expect(await usdc.balance()).toBeGreaterThanOrEqual(before);
    await positions.remove(id, 5_000);
    expect((await positions.mine())[0]!.liquidity).toBeGreaterThan(0n);
    await positions.remove(id, 10_000);
    expect(await positions.mine()).toEqual([]);
    expect(await usdc.balance()).toBeGreaterThan(before);
  });

  it("gives a position to a receive address and takes one out to a wallet, then back in", async () => {
    const { positions, pool } = await funded();
    const { tickLower, tickUpper } = rangeAround(pool.tick, pool.fee, 10);
    const id = await positions.open(pool.address, tickLower, tickUpper, 20n * USD, USD / 100n);
    const to = await positions.receiveAddress();
    await positions.give(id, to);
    expect((await positions.mine()).map((p) => p.positionId)).toEqual([id]);
    await positions.give(id, FRESH);
    expect(await positions.mine()).toEqual([]);
    expect(await code(positions.collect(id))).toBe("NotController");

    const [outside] = await positions.walletPositions();
    expect(outside).toBeDefined();
    const back = await positions.deposit(outside!.tokenId);
    expect((await positions.mine()).map((p) => p.positionId)).toEqual([back]);
    await positions.takeOut(back, FRESH);
    expect(await positions.mine()).toEqual([]);
  });
});
