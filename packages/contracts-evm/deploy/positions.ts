import { Contract, ContractFactory, parseUnits } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync } from "node:fs";
import { otherPocketSymbols, pocketsDeployment } from "../lib/pocketTokens";
import { POSITION_POOLS, POSITIONS_UNISWAP, positionsFeeBps, type UniswapV3Deployment } from "../lib/positionPools";
import { MAX_TICK, MIN_TICK, sqrtRatioAtTick, TICK_SPACING } from "../lib/uniswapV3";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function mint(address, uint256)",
];
const NPM_ABI = [
  "function factory() view returns (address)",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];
const FACTORY_ABI = ["function getPool(address, address, uint24) view returns (address)"];
const POOL_ABI = ["function liquidity() view returns (uint128)"];

/** Uniswap's own build of a periphery or core contract. */
function uniswapArtifact(path: string) {
  const json = JSON.parse(readFileSync(require.resolve(path), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode as string };
}

/**
 * The sealed vault's liquidity positions (SealedPositions): Uniswap V3 positions funded out of the
 * pockets and paying back into them. Takes every token with pockets on the network (cUSDC, and
 * cUSDT, cWETH, cZAMA on Sepolia; cUSDC and a test cWETH locally), is made a desk of each of their
 * pockets, and opens the pools of lib/positionPools.ts between their ERC-20s where nobody has,
 * each seeded with a full-range position of the deployer's (Zama's test tokens are free to mint).
 *
 * Uniswap V3 is the live deployment on Sepolia; a local node (`pnpm chain`) gets Uniswap's own
 * bytecode first. The fee (POSITIONS_FEE_BPS, 5% of the trading fees by default) goes to
 * STUDIO_TREASURY, or the owner. Runs after the pockets: `--tags Positions` adds it to a live vault.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, execute, read, save, getOrNull } = hre.deployments;
  const owner = process.env.COLLECTION_OWNER || deployer!;
  const treasury = process.env.STUDIO_TREASURY || owner;
  const signer = await hre.ethers.getSigner(deployer!);

  let uniswap: UniswapV3Deployment | undefined = POSITIONS_UNISWAP[hre.network.name];
  if (!uniswap) {
    if (hre.network.config.chainId !== 31337) throw new Error(`No Uniswap V3 known on ${hre.network.name}.`);
    uniswap = await localUniswap(hre, signer);
  }
  const npm = new Contract(uniswap.positionManager, NPM_ABI, signer);
  if ((await npm.factory!()).toLowerCase() !== uniswap.factory.toLowerCase()) throw new Error(`${uniswap.positionManager} does not belong to the factory ${uniswap.factory}`);

  // Owned by the deployer until every token is in, then by the owner.
  const positions = await deploy("SealedPositions", { from: deployer!, args: [uniswap.positionManager, treasury, deployer, positionsFeeBps()], log: true });
  const names = ["SealedPockets", ...otherPocketSymbols(hre.network.name, hre.network.config.chainId).map(pocketsDeployment)];
  const underlyings: Record<string, { address: string; decimals: number }> = {};
  for (const name of names) {
    const pockets = await getOrNull(name);
    if (!pockets) continue;
    if (!(await read(name, "isDesk", positions.address))) {
      await execute(name, { from: deployer!, log: true }, "addDesk", positions.address);
    }
    const token = await hre.ethers.getContractAt(["function underlying() view returns (address)"], await read(name, "token"));
    const underlying = String(await token.underlying!());
    const side = await read("SealedPositions", "sideOf", underlying);
    if (side.pockets === "0x0000000000000000000000000000000000000000") {
      await execute("SealedPositions", { from: deployer!, log: true }, "addPockets", pockets.address);
    }
    const erc20 = new Contract(underlying, ERC20_ABI, signer);
    underlyings[String(await erc20.symbol!()).replace(/Mock$/, "")] = { address: underlying, decimals: Number(await erc20.decimals!()) };
  }
  if ((await read("SealedPositions", "owner")).toLowerCase() !== owner.toLowerCase()) {
    await execute("SealedPositions", { from: deployer!, log: true }, "transferOwnership", owner);
  }
  console.log(`SealedPositions: ${positions.address} (Uniswap ${uniswap.positionManager}, fee ${positionsFeeBps() / 100}% of trading fees to ${treasury}, tokens ${Object.keys(underlyings).join(", ")})`);

  // The pools, opened and seeded where nobody has.
  const factory = new Contract(uniswap.factory, FACTORY_ABI, signer);
  const pools = [];
  for (const plan of POSITION_POOLS[hre.network.name] ?? []) {
    const base = underlyings[plan.base];
    const quote = underlyings[plan.quote];
    if (!base || !quote) continue;
    const baseFirst = BigInt(base.address) < BigInt(quote.address);
    const [t0, t1] = baseFirst ? [base, quote] : [quote, base];
    const spacing = TICK_SPACING[plan.fee]!;
    // Raw price: token1's smallest units per token0's.
    const raw = (baseFirst ? plan.price : 1 / plan.price) * 10 ** (t1.decimals - t0.decimals);
    const tick = Math.round(Math.log(raw) / Math.log(1.0001));
    let pool: string = await factory.getPool!(t0.address, t1.address, plan.fee);
    if (pool === "0x0000000000000000000000000000000000000000") {
      await (await npm.createAndInitializePoolIfNecessary!(t0.address, t1.address, plan.fee, sqrtRatioAtTick(tick))).wait();
      pool = await factory.getPool!(t0.address, t1.address, plan.fee);
      console.log(`pool ${plan.base}/${plan.quote} ${plan.fee / 10_000}%: ${pool}`);
    }
    if ((await new Contract(pool, POOL_ABI, signer).liquidity!()) === 0n) {
      const seed0 = parseUnits(String(baseFirst ? plan.seedBase : plan.seedQuote), t0.decimals);
      const seed1 = parseUnits(String(baseFirst ? plan.seedQuote : plan.seedBase), t1.decimals);
      for (const [t, amount] of [[t0, seed0], [t1, seed1]] as const) {
        const erc20 = new Contract(t.address, ERC20_ABI, signer);
        const held: bigint = await erc20.balanceOf!(deployer);
        if (held < amount) await (await erc20.mint!(deployer, amount - held)).wait();
        if ((await erc20.allowance!(deployer, uniswap.positionManager)) < amount) await (await erc20.approve!(uniswap.positionManager, amount)).wait();
      }
      await (
        await npm.mint!({
          token0: t0.address,
          token1: t1.address,
          fee: plan.fee,
          tickLower: Math.ceil(MIN_TICK / spacing) * spacing,
          tickUpper: Math.floor(MAX_TICK / spacing) * spacing,
          amount0Desired: seed0,
          amount1Desired: seed1,
          amount0Min: 0,
          amount1Min: 0,
          recipient: deployer,
          deadline: (await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600,
        })
      ).wait();
      console.log(`  seeded: ${plan.seedBase} ${plan.base} + ${plan.seedQuote} ${plan.quote}, full range`);
    }
    pools.push({ address: pool, token0: t0.address, token1: t1.address, fee: plan.fee });
  }
  await save("PositionPools", { address: positions.address, abi: [], linkedData: { uniswap, pools } });
};

/** Uniswap V3 on a local node, from Uniswap's own bytecode, deployed once and remembered. */
async function localUniswap(hre: HardhatRuntimeEnvironment, signer: Awaited<ReturnType<HardhatRuntimeEnvironment["ethers"]["getSigner"]>>): Promise<UniswapV3Deployment> {
  const { save, getOrNull } = hre.deployments;
  const known = await getOrNull("UniswapV3Factory");
  if (known) {
    return { factory: known.address, positionManager: (await hre.deployments.get("NonfungiblePositionManager")).address, swapRouter: (await hre.deployments.get("UniswapV3SwapRouter")).address };
  }
  const make = async (name: string, path: string, ...args: unknown[]) => {
    const a = uniswapArtifact(path);
    const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    const address = await c.getAddress();
    await save(name, { address, abi: a.abi });
    return address;
  };
  const weth = (await hre.deployments.get("TestERC20_WETH")).address;
  const factory = await make("UniswapV3Factory", "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
  const positionManager = await make("NonfungiblePositionManager", "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json", factory, weth, weth);
  const swapRouter = await make("UniswapV3SwapRouter", "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json", factory, weth);
  console.log(`Uniswap V3 (local): factory ${factory}, position manager ${positionManager}, router ${swapRouter}`);
  return { factory, positionManager, swapRouter };
}

export default func;
func.id = "deploy_positions";
func.tags = ["Positions"];
func.dependencies = ["Pockets"];
func.runAtTheEnd = true;
