/**
 * Reading a Uniswap V3 pool where CROQ is sold from one locked position, the way the rest of the
 * app reads a constant-product pool. Inside a position's range, V3 trades exactly like a V2 pool
 * holding the "virtual" reserves L/√P and L·√P; past the range edges nothing trades at all.
 * Shared by the EVM adapter and the API.
 */

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** TickMath's factors: sqrt(1.0001)^-(2^i) as Q128.128, for bit i of |tick| from 1. */
const FACTORS: [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** Uniswap V3's `TickMath.getSqrtRatioAtTick`, bit for bit: sqrt(1.0001^tick) as a Q64.96. */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  const abs = Math.abs(tick);
  let ratio = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, factor] of FACTORS) if (abs & bit) ratio = (ratio * factor) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** How the locked position sits in the pool, as `dno:export` writes it. */
export interface V3Position {
  /** The CROQ token's address: Uniswap orders the pair by address. */
  croq: string;
  quote: string;
  tickLower: number;
  tickUpper: number;
}

export interface V3PoolState {
  sqrtPriceX96: bigint;
  /** The pool's active liquidity right now: 0 when the price sits past every position. */
  liquidity: bigint;
  /** The locked position's liquidity, used when the price has left its range. */
  positionLiquidity: bigint;
}

const croqIsToken0 = (p: V3Position) => BigInt(p.croq) < BigInt(p.quote);

/**
 * The reserves a constant-product pool would need to quote like this one does now: CROQ and
 * the quote token in their smallest units. The price is held inside the position's range,
 * since past it nothing trades and the next swap crosses the gap for free.
 */
export function virtualReserves(position: V3Position, state: V3PoolState): { croq: bigint; quote: bigint } {
  const lower = sqrtRatioAtTick(position.tickLower);
  const upper = sqrtRatioAtTick(position.tickUpper);
  const inside = state.sqrtPriceX96 > lower && state.sqrtPriceX96 < upper;
  const sqrtP = state.sqrtPriceX96 < lower ? lower : state.sqrtPriceX96 > upper ? upper : state.sqrtPriceX96;
  const liquidity = inside && state.liquidity > 0n ? state.liquidity : state.positionLiquidity;
  if (liquidity === 0n) return { croq: 0n, quote: 0n };
  const token0 = (liquidity * Q96) / sqrtP;
  const token1 = (liquidity * sqrtP) / Q96;
  return croqIsToken0(position) ? { croq: token0, quote: token1 } : { croq: token1, quote: token0 };
}

/**
 * The quote token's smallest units per 1,000 CROQ where the range starts (the least CROQ ever
 * sells for) and where it ends (where the last of it goes).
 */
export function rangePerThousand(position: V3Position): { from: bigint; to: bigint } {
  const perThousand = (tick: number) => {
    const s = sqrtRatioAtTick(tick);
    // Raw price token1/token0 = s² / 2^192, in smallest units of each.
    return croqIsToken0(position) ? (s * s * 1000n) >> 192n : ((1n << 192n) * 1000n) / (s * s);
  };
  const [a, b] = [perThousand(position.tickLower), perThousand(position.tickUpper)];
  return a < b ? { from: a, to: b } : { from: b, to: a };
}
