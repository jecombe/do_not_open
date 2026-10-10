import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Contract, ContractFactory } from "ethers";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { MAX_TICK, MIN_TICK, sqrtRatioAtTick, TICK_SPACING } from "../lib/uniswapV3";

/** Uniswap's own builds, the bytecode deployed on every network. */
function artifact(path: string) {
  const json = JSON.parse(readFileSync(require.resolve(path), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode as string };
}
export const UNISWAP = {
  factory: artifact("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
  pool: artifact("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"),
  positionManager: artifact("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
  router: artifact("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json"),
};

export interface Uniswap {
  factory: Contract;
  positionManager: Contract;
  router: Contract;
}

/** Uniswap V3's factory, position manager and router, from Uniswap's own bytecode. */
export async function deployUniswap(deployer: HardhatEthersSigner): Promise<Uniswap> {
  const make = async (a: { abi: unknown[]; bytecode: string }, ...args: unknown[]) => {
    const c = await new ContractFactory(a.abi as never, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c as unknown as Contract;
  };
  // Nothing here wraps ETH: any address does for WETH9, and for the NFT descriptor.
  const factory = await make(UNISWAP.factory);
  const factoryAddress = await factory.getAddress();
  const positionManager = await make(UNISWAP.positionManager, factoryAddress, deployer.address, deployer.address);
  const router = await make(UNISWAP.router, factoryAddress, deployer.address);
  return { factory, positionManager, router };
}

/** The tick nearest a raw price (token1's smallest units per token0's), on the fee tier's spacing. */
export function tickAt(rawPrice: number, fee: number): number {
  const spacing = TICK_SPACING[fee]!;
  return Math.round(Math.log(rawPrice) / Math.log(1.0001) / spacing) * spacing;
}

/** A pool for `a` and `b` opened at `rawPrice` (b per a, smallest units), and the pair sorted. */
export async function openPool(u: Uniswap, a: string, b: string, fee: number, rawPriceBPerA: number) {
  const aFirst = BigInt(a) < BigInt(b);
  const [token0, token1] = aFirst ? [a, b] : [b, a];
  const tick = tickAt(aFirst ? rawPriceBPerA : 1 / rawPriceBPerA, fee);
  await (await u.positionManager.createAndInitializePoolIfNecessary!(token0, token1, fee, sqrtRatioAtTick(tick))).wait();
  const pool = new Contract(await u.factory.getPool!(token0, token1, fee), UNISWAP.pool.abi, u.positionManager.runner);
  return { pool, token0, token1, tick, aFirst };
}

/** Full-range liquidity from `who`, so the pool trades. */
export async function seedFullRange(u: Uniswap, who: HardhatEthersSigner, token0: string, token1: string, fee: number, amount0: bigint, amount1: bigint) {
  const spacing = TICK_SPACING[fee]!;
  const npm = u.positionManager.connect(who) as Contract;
  for (const t of [token0, token1]) await (await (await ethers.getContractAt("TestERC20", t)).connect(who).approve(await npm.getAddress(), ethers.MaxUint256)).wait();
  await (
    await npm.mint!({
      token0,
      token1,
      fee,
      tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
      tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min: 0,
      amount1Min: 0,
      recipient: who.address,
      deadline: (await time.latest()) + 3600,
    })
  ).wait();
}

/** `who` sells `amountIn` of `tokenIn` for the other token: trading fees for the positions in range. */
export async function swap(u: Uniswap, who: HardhatEthersSigner, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint) {
  const router = u.router.connect(who) as Contract;
  const erc20 = (await ethers.getContractAt("TestERC20", tokenIn)).connect(who);
  if ((await erc20.allowance(who.address, await router.getAddress())) < amountIn) await (await erc20.approve(await router.getAddress(), ethers.MaxUint256)).wait();
  await (
    await router.exactInputSingle!({
      tokenIn,
      tokenOut,
      fee,
      recipient: who.address,
      deadline: (await time.latest()) + 3600,
      amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    })
  ).wait();
}
