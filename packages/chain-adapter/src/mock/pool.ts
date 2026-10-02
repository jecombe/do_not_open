/**
 * The mock's CROQ/USDC market: one Uniswap V3 position holding only CROQ, from a start price
 * up to a multiple of it. Inside the range it trades like a constant-product pool on the
 * virtual reserves L/√P and L·√P; CROQ never sells below the start, and once the last of it
 * is gone nothing more can be bought. Prices are in USDC's smallest unit per whole CROQ.
 */
export class MockPool {
  private readonly liquidity: number;
  private readonly sqrtLow: number;
  private readonly sqrtHigh: number;
  private sqrtPrice: number;

  constructor(
    croq: bigint,
    /** USDC units per CROQ where the range starts. */
    readonly startPrice: number,
    readonly rangeFactor: number,
    /** What the pool keeps of every input, in basis points. */
    readonly feeBps: number,
  ) {
    this.sqrtLow = Math.sqrt(startPrice);
    this.sqrtHigh = Math.sqrt(startPrice * rangeFactor);
    this.sqrtPrice = this.sqrtLow;
    this.liquidity = Number(croq) / (1 / this.sqrtLow - 1 / this.sqrtHigh);
  }

  /** What the pool holds: whole CROQ and USDC units. */
  held(): { croq: bigint; usdc: bigint } {
    const L = this.liquidity;
    return {
      croq: BigInt(Math.round(L * (1 / this.sqrtPrice - 1 / this.sqrtHigh))),
      usdc: BigInt(Math.round(L * (this.sqrtPrice - this.sqrtLow))),
    };
  }

  /** The reserves a constant-product pool would quote with right now. */
  virtual(): { croq: bigint; usdc: bigint } {
    return { croq: BigInt(Math.floor(this.liquidity / this.sqrtPrice)), usdc: BigInt(Math.floor(this.liquidity * this.sqrtPrice)) };
  }

  /** Where CROQ sells, in USDC units per 1,000 CROQ. */
  range(): { from: bigint; to: bigint } {
    return { from: BigInt(Math.round(this.startPrice * 1000)), to: BigInt(Math.round(this.startPrice * this.rangeFactor * 1000)) };
  }

  /**
   * A swap of `amountIn` (USDC to buy, CROQ to sell): what comes out, what it actually takes
   * (less than offered when it reaches the end of the range) and the price it leaves. Nothing
   * changes until `apply`.
   */
  swap(side: "buy" | "sell", amountIn: bigint): { out: bigint; used: bigint; sqrtPrice: number } {
    const L = this.liquidity;
    const keep = 1 - this.feeBps / 10_000;
    const net = Number(amountIn) * keep;
    if (side === "buy") {
      const next = Math.min(this.sqrtPrice + net / L, this.sqrtHigh);
      const out = BigInt(Math.floor(L * (1 / this.sqrtPrice - 1 / next)));
      const used = next < this.sqrtHigh ? amountIn : BigInt(Math.ceil(((next - this.sqrtPrice) * L) / keep));
      return { out, used: used > amountIn ? amountIn : used, sqrtPrice: next };
    }
    const next = Math.max(1 / (1 / this.sqrtPrice + net / L), this.sqrtLow);
    const out = BigInt(Math.floor(L * (this.sqrtPrice - next)));
    const used = next > this.sqrtLow ? amountIn : BigInt(Math.ceil((L * (1 / next - 1 / this.sqrtPrice)) / keep));
    return { out, used: used > amountIn ? amountIn : used, sqrtPrice: next };
  }

  apply(result: { sqrtPrice: number }): void {
    this.sqrtPrice = result.sqrtPrice;
  }
}
