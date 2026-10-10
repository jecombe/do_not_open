/**
 * Uniswap V3's position math, bit for bit where it matters: how much liquidity two amounts buy
 * on a price range, what a position's liquidity is worth at a price, and the ticks a price
 * falls on. Shared by the mock, the EVM adapter and the page (no chain library).
 */
import { MAX_TICK, MIN_TICK, sqrtRatioAtTick } from "./evm/uniswapV3";

export { MAX_TICK, MIN_TICK, sqrtRatioAtTick };

const Q96 = 1n << 96n;
const LOG_BASE = Math.log(1.0001);

/** Tick spacing per fee tier (hundredths of a bip), as enabled on every Uniswap V3 factory. */
export const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/** The lowest and highest ticks a fee tier's positions may use: the full range. */
export function fullRange(fee: number): { tickLower: number; tickUpper: number } {
  const spacing = TICK_SPACING[fee] ?? 60;
  return { tickLower: Math.ceil(MIN_TICK / spacing) * spacing, tickUpper: Math.floor(MAX_TICK / spacing) * spacing };
}

/** LiquidityAmounts.getLiquidityForAmount0: the liquidity `amount0` buys between two prices. */
function liquidityFor0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount0 * ((sqrtA * sqrtB) / Q96)) / (sqrtB - sqrtA);
}

/** LiquidityAmounts.getLiquidityForAmount1. */
function liquidityFor1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

/** LiquidityAmounts.getAmount0ForLiquidity. */
function amount0For(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return ((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB / sqrtA;
}

/** LiquidityAmounts.getAmount1ForLiquidity. */
function amount1For(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

/** The most liquidity `amount0` and `amount1` (smallest units) buy on [tickLower, tickUpper] at `sqrtPriceX96`. */
export function liquidityForAmounts(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint): bigint {
  const a = sqrtRatioAtTick(tickLower);
  const b = sqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= a) return liquidityFor0(a, b, amount0);
  if (sqrtPriceX96 < b) {
    const l0 = liquidityFor0(sqrtPriceX96, b, amount0);
    const l1 = liquidityFor1(a, sqrtPriceX96, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityFor1(a, b, amount1);
}

/** What `liquidity` on [tickLower, tickUpper] is worth at `sqrtPriceX96`, in each token's smallest units. */
export function amountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const a = sqrtRatioAtTick(tickLower);
  const b = sqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= a) return { amount0: amount0For(a, b, liquidity), amount1: 0n };
  if (sqrtPriceX96 < b) return { amount0: amount0For(sqrtPriceX96, b, liquidity), amount1: amount1For(a, sqrtPriceX96, liquidity) };
  return { amount0: 0n, amount1: amount1For(a, b, liquidity) };
}

/**
 * The other token a deposit of `amount` of one side needs on [tickLower, tickUpper] at the
 * pool's price, so neither is left over: 0 when the range only takes the side given, and null
 * when it does not take that side at all (the price sits past the range on that side).
 */
export function pairedAmount(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, side: 0 | 1, amount: bigint): bigint | null {
  const a = sqrtRatioAtTick(tickLower);
  const b = sqrtRatioAtTick(tickUpper);
  if (side === 0) {
    if (sqrtPriceX96 >= b) return null;
    if (sqrtPriceX96 <= a) return 0n;
    return amount1For(a, sqrtPriceX96, liquidityFor0(sqrtPriceX96, b, amount));
  }
  if (sqrtPriceX96 <= a) return null;
  if (sqrtPriceX96 >= b) return 0n;
  return amount0For(sqrtPriceX96, b, liquidityFor1(a, sqrtPriceX96, amount));
}

/** Whole token1 per whole token0 at a sqrt price, as a float, for the page. */
export function priceOf(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s * 10 ** (decimals0 - decimals1);
}

/** Whole token1 per whole token0 at a tick. */
export function priceAtTick(tick: number, decimals0: number, decimals1: number): number {
  return Math.exp(tick * LOG_BASE) * 10 ** (decimals0 - decimals1);
}

/** The usable tick (on `fee`'s spacing) nearest a price of whole token1 per whole token0, within Uniswap's bounds. */
export function tickForPrice(price: number, decimals0: number, decimals1: number, fee: number): number {
  const spacing = TICK_SPACING[fee] ?? 60;
  const { tickLower: min, tickUpper: max } = fullRange(fee);
  if (!(price > 0) || !Number.isFinite(price)) return price > 0 ? max : min;
  const raw = Math.log(price * 10 ** (decimals1 - decimals0)) / LOG_BASE;
  return Math.max(min, Math.min(max, Math.round(raw / spacing) * spacing));
}

/** A range `pct` percent around the pool's tick (both sides), on the fee tier's spacing: 0 or less is the full range. */
export function rangeAround(tick: number, fee: number, pct: number): { tickLower: number; tickUpper: number } {
  if (!(pct > 0)) return fullRange(fee);
  const spacing = TICK_SPACING[fee] ?? 60;
  const { tickLower: min, tickUpper: max } = fullRange(fee);
  const up = Math.log(1 + pct / 100) / LOG_BASE;
  const down = -Math.log(Math.max(1e-9, 1 - pct / 100)) / LOG_BASE;
  const tickLower = Math.max(min, Math.floor((tick - down) / spacing) * spacing);
  const tickUpper = Math.min(max, Math.ceil((tick + up) / spacing) * spacing);
  return tickUpper > tickLower ? { tickLower, tickUpper } : { tickLower, tickUpper: tickLower + spacing };
}
