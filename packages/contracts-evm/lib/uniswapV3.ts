import { Contract, type Signer } from "ethers";

/**
 * Opening a Uniswap V3 market with one token only. A V3 position covers a price range; one that
 * starts exactly at the pool's price holds only the token being sold, so the creator puts in CROQ
 * and no USDC. Buyers bring the USDC, and the price never goes below where the range starts.
 */

/** Tick spacing per fee tier (hundredths of a bip), as enabled on every Uniswap V3 factory. */
export const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const Q32 = 1n << 32n;
const MAX_UINT256 = (1n << 256n) - 1n;
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
  return (ratio >> 32n) + (ratio % Q32 === 0n ? 0n : 1n);
}

export interface SingleSidedParams {
  croq: string;
  quote: string;
  croqDecimals: number;
  quoteDecimals: number;
  /** Where the range starts: the quote token per whole CROQ, e.g. "0.001". */
  startPrice: string;
  /** Where it ends, as a multiple of the start: 1000 sells the last CROQ at 1000x. */
  rangeFactor: number;
  /** Fee tier in hundredths of a bip: 10000 is 1%. */
  fee: number;
  /** CROQ to put in, in its smallest unit. */
  croqAmount: bigint;
}

export interface SingleSidedPlan {
  token0: string;
  token1: string;
  croqIsToken0: boolean;
  fee: number;
  tickLower: number;
  tickUpper: number;
  /** The pool's opening price, exactly at the edge of the range where CROQ is sold first. */
  sqrtPriceX96: bigint;
  amount0Desired: bigint;
  amount1Desired: bigint;
}

/** 1.0001^tick as a float: the pool's raw price, token1 units per token0 unit. */
const LOG_BASE = Math.log(1.0001);

/**
 * Where a CROQ-only position goes. Uniswap prices token1 in token0 and orders the two by address,
 * so CROQ is sold as the price rises when it is token0 and as it falls when it is token1. The
 * opening tick is rounded so CROQ never opens below `startPrice`.
 */
export function planSingleSided(p: SingleSidedParams): SingleSidedPlan {
  const spacing = TICK_SPACING[p.fee];
  if (!spacing) throw new Error(`fee tier ${p.fee} is not enabled on Uniswap V3`);
  const start = Number(p.startPrice);
  if (!(start > 0)) throw new Error(`start price ${p.startPrice} must be positive`);
  if (!(p.rangeFactor > 1)) throw new Error(`range factor ${p.rangeFactor} must be above 1`);
  if (p.croqAmount <= 0n) throw new Error("nothing to put in");
  const croqIsToken0 = BigInt(p.croq) < BigInt(p.quote);
  // Raw price of one smallest CROQ unit in the quote token's smallest units.
  const raw = start * 10 ** (p.quoteDecimals - p.croqDecimals);
  const width = Math.max(spacing, Math.round(Math.log(p.rangeFactor) / LOG_BASE / spacing) * spacing);
  const minUsable = Math.ceil(MIN_TICK / spacing) * spacing;
  const maxUsable = Math.floor(MAX_TICK / spacing) * spacing;
  let tickLower: number;
  let tickUpper: number;
  if (croqIsToken0) {
    // Price = quote per CROQ; CROQ goes as it rises, from tickLower up.
    tickLower = Math.ceil(Math.log(raw) / LOG_BASE / spacing) * spacing;
    tickUpper = Math.min(tickLower + width, maxUsable);
  } else {
    // Price = CROQ per quote; CROQ goes as it falls, from tickUpper down.
    tickUpper = Math.floor(-Math.log(raw) / LOG_BASE / spacing) * spacing;
    tickLower = Math.max(tickUpper - width, minUsable);
  }
  if (tickLower < minUsable || tickUpper > maxUsable || tickLower >= tickUpper) {
    throw new Error(`start price ${p.startPrice} is outside what Uniswap V3 can price`);
  }
  return {
    token0: croqIsToken0 ? p.croq : p.quote,
    token1: croqIsToken0 ? p.quote : p.croq,
    croqIsToken0,
    fee: p.fee,
    tickLower,
    tickUpper,
    sqrtPriceX96: sqrtRatioAtTick(croqIsToken0 ? tickLower : tickUpper),
    amount0Desired: croqIsToken0 ? p.croqAmount : 0n,
    amount1Desired: croqIsToken0 ? 0n : p.croqAmount,
  };
}

/** The quote token per whole CROQ at a pool tick, as a float, for logs and checks. */
export function croqPriceAtTick(tick: number, croqIsToken0: boolean, croqDecimals: number, quoteDecimals: number): number {
  const raw = Math.exp(tick * LOG_BASE);
  return (croqIsToken0 ? raw : 1 / raw) * 10 ** (croqDecimals - quoteDecimals);
}

export const POSITION_MANAGER_ABI = [
  "function factory() view returns (address)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];
export const FACTORY_ABI = ["function getPool(address, address, uint24) view returns (address)"];
export const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];
const ERC20_ABI = ["function approve(address, uint256) returns (bool)", "function allowance(address, address) view returns (uint256)"];

export interface SeededMarket {
  pool: string;
  positionId: bigint;
  liquidity: bigint;
  /** CROQ that went in: a few units under the amount asked, from Uniswap's rounding. */
  croqIn: bigint;
}

/**
 * Opens the pool at the plan's price, puts the CROQ in and hands the position to the locker for
 * good. Stops if someone opened the pool at another price first: a position minted there could
 * end up needing the quote token, or selling CROQ below the start.
 */
export async function seedSingleSided(
  signer: Signer,
  positionManager: string,
  locker: string,
  plan: SingleSidedPlan,
  log: (line: string) => void = () => {},
): Promise<SeededMarket> {
  const me = await signer.getAddress();
  const npm = new Contract(positionManager, POSITION_MANAGER_ABI, signer);
  const factory = new Contract(await npm.factory!(), FACTORY_ABI, signer);

  let pool: string = await factory.getPool!(plan.token0, plan.token1, plan.fee);
  if (pool === "0x0000000000000000000000000000000000000000") {
    await (await npm.createAndInitializePoolIfNecessary!(plan.token0, plan.token1, plan.fee, plan.sqrtPriceX96)).wait();
    pool = await factory.getPool!(plan.token0, plan.token1, plan.fee);
    log(`pool opened     : ${pool}`);
  }
  const [sqrtPriceX96] = await new Contract(pool, POOL_ABI, signer).slot0!();
  if (sqrtPriceX96 !== plan.sqrtPriceX96) {
    throw new Error(`the pool ${pool} already trades at sqrtPriceX96 ${sqrtPriceX96}, not ${plan.sqrtPriceX96}: not seeding it`);
  }

  const croq = new Contract(plan.croqIsToken0 ? plan.token0 : plan.token1, ERC20_ABI, signer);
  const croqAmount = plan.croqIsToken0 ? plan.amount0Desired : plan.amount1Desired;
  if ((await croq.allowance!(me, positionManager)) < croqAmount) {
    await (await croq.approve!(positionManager, croqAmount)).wait();
  }
  // At most 0.01% left out by rounding; the quote side must stay at zero.
  const croqMin = croqAmount - croqAmount / 10_000n;
  const receipt = await (
    await npm.mint!({
      token0: plan.token0,
      token1: plan.token1,
      fee: plan.fee,
      tickLower: plan.tickLower,
      tickUpper: plan.tickUpper,
      amount0Desired: plan.amount0Desired,
      amount1Desired: plan.amount1Desired,
      amount0Min: plan.croqIsToken0 ? croqMin : 0n,
      amount1Min: plan.croqIsToken0 ? 0n : croqMin,
      recipient: me,
      // From the chain's clock, not this machine's: a test network may run ahead.
      deadline: (await signer.provider!.getBlock("latest"))!.timestamp + 3600,
    })
  ).wait();
  const event = receipt.logs
    .map((l: { topics: string[]; data: string }) => {
      try {
        return npm.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e: { name: string } | null) => e?.name === "IncreaseLiquidity");
  if (!event) throw new Error("the mint emitted no IncreaseLiquidity");
  const positionId: bigint = event.args.tokenId;
  const liquidity: bigint = event.args.liquidity;
  const croqIn: bigint = plan.croqIsToken0 ? event.args.amount0 : event.args.amount1;
  const quoteIn: bigint = plan.croqIsToken0 ? event.args.amount1 : event.args.amount0;
  if (quoteIn !== 0n) throw new Error(`the position took ${quoteIn} of the quote token`);
  log(`position       : #${positionId}, ${croqIn} CROQ, liquidity ${liquidity}`);

  await (await npm.safeTransferFrom!(me, locker, positionId)).wait();
  log(`locked in      : ${locker}`);
  return { pool, positionId, liquidity, croqIn };
}
