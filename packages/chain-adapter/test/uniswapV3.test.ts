import { describe, expect, it } from "vitest";
import { MAX_TICK, MIN_TICK, rangePerThousand, sqrtRatioAtTick, virtualReserves } from "../src/evm/uniswapV3";

/** The Sepolia pool as deployed: CROQ sorts after USDC, so it is token1 and sells as the price falls. */
const SEPOLIA = {
  croq: "0xbedb039CB104bD8e60A5eD7844fCE7961d0451F7",
  quote: "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF",
  tickLower: -138200,
  tickUpper: -69200,
};
const LIQUIDITY = 131_418_578n;
/** The same range mirrored, as it would sit with CROQ as token0. */
const MIRRORED = { croq: SEPOLIA.quote, quote: SEPOLIA.croq, tickLower: 69200, tickUpper: 138200 };

describe("Uniswap V3 math", () => {
  it("matches TickMath at its bounds and at zero", () => {
    expect(sqrtRatioAtTick(MIN_TICK)).toBe(4295128739n);
    expect(sqrtRatioAtTick(MAX_TICK)).toBe(1461446703485210103287273052203988822378723970342n);
    expect(sqrtRatioAtTick(0)).toBe(1n << 96n);
    expect(() => sqrtRatioAtTick(MAX_TICK + 1)).toThrow();
  });

  it("reads the Sepolia range as 0.001 to 1 USDC per CROQ", () => {
    const { from, to } = rangePerThousand(SEPOLIA);
    // Per 1,000 CROQ in USDC units: about 1.012 USDC at the start, about 1,004 at the end.
    expect(Number(from) / 1e6).toBeCloseTo(1.012, 2);
    expect(Number(to) / 1e6).toBeCloseTo(1004, -1);
    const mirrored = rangePerThousand(MIRRORED);
    expect(Number(mirrored.from)).toBeCloseTo(Number(from), -3);
    expect(Number(mirrored.to)).toBeCloseTo(Number(to), -5);
  });

  it("prices like a constant-product pool at the opening price", () => {
    const r = virtualReserves(SEPOLIA, { sqrtPriceX96: sqrtRatioAtTick(SEPOLIA.tickUpper), liquidity: 0n, positionLiquidity: LIQUIDITY });
    // Out of range at the very edge, the position's own liquidity prices it.
    // In USDC units per CROQ: 0.001012 USDC.
    const perCroq = Number(r.quote) / Number(r.croq);
    expect(perCroq).toBeCloseTo(1012, -1);
    // More virtual CROQ than the pool holds: the reserves include the range's far side.
    expect(r.croq).toBeGreaterThan(4_000_000n);
  });

  it("holds the price at the range edge when the pool's price has left it", () => {
    const edge = virtualReserves(SEPOLIA, { sqrtPriceX96: sqrtRatioAtTick(SEPOLIA.tickUpper), liquidity: 0n, positionLiquidity: LIQUIDITY });
    // A seller pushed the price far past the range, where nothing trades.
    const past = virtualReserves(SEPOLIA, { sqrtPriceX96: sqrtRatioAtTick(0), liquidity: 0n, positionLiquidity: LIQUIDITY });
    expect(past).toEqual(edge);
  });

  it("uses the pool's active liquidity inside the range", () => {
    const mid = sqrtRatioAtTick(-100000);
    const own = virtualReserves(SEPOLIA, { sqrtPriceX96: mid, liquidity: LIQUIDITY, positionLiquidity: LIQUIDITY });
    const doubled = virtualReserves(SEPOLIA, { sqrtPriceX96: mid, liquidity: 2n * LIQUIDITY, positionLiquidity: LIQUIDITY });
    expect(Number(doubled.croq - 2n * own.croq)).toBeLessThanOrEqual(1);
    expect(Number(doubled.croq - 2n * own.croq)).toBeGreaterThanOrEqual(-1);
    // Same price either way.
    expect(Number(doubled.quote) / Number(doubled.croq)).toBeCloseTo(Number(own.quote) / Number(own.croq), 1);
  });

  it("swaps the sides when CROQ is token0", () => {
    const a = virtualReserves(SEPOLIA, { sqrtPriceX96: sqrtRatioAtTick(-100000), liquidity: LIQUIDITY, positionLiquidity: LIQUIDITY });
    const b = virtualReserves(MIRRORED, { sqrtPriceX96: sqrtRatioAtTick(100000), liquidity: LIQUIDITY, positionLiquidity: LIQUIDITY });
    expect(Number(b.croq)).toBeCloseTo(Number(a.croq), -1);
    expect(Number(b.quote)).toBeCloseTo(Number(a.quote), -1);
  });

  it("gives nothing for a pool with no liquidity at all", () => {
    expect(virtualReserves(SEPOLIA, { sqrtPriceX96: sqrtRatioAtTick(-100000), liquidity: 0n, positionLiquidity: 0n })).toEqual({ croq: 0n, quote: 0n });
  });
});
