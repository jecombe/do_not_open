import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ratParamsFromSpec } from "../lib/ratParams";
import { economyFromSpec, pantryParamsFromSpec } from "../lib/specParams";
import { croqPriceAtTick, planSingleSided, seedSingleSided } from "../lib/uniswapV3";
import { PAYMENT_TOKENS } from "../lib/paymentTokens";

/**
 * Uniswap V3 on Sepolia, from Uniswap's deployment list. Checked on-chain before use: the position
 * manager, the swap router and the quoter must all point at this factory.
 */
export const UNISWAP_V3: Record<string, { factory: string; positionManager: string; swapRouter: string; quoter: string }> = {
  sepolia: {
    factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
    positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
    swapRouter: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
  },
};

/** How the CROQ-only position is laid out, overridable from the environment. */
export function marketParams() {
  return {
    /** USDC per CROQ where the range starts: the lowest price CROQ ever sells at. */
    startPrice: process.env.LIQUIDITY_START_PRICE || "0.001",
    /** Where the range ends, as a multiple of the start. */
    rangeFactor: Number(process.env.LIQUIDITY_RANGE || "1000"),
    /** 1%: the fee tier for volatile pairs. */
    fee: Number(process.env.LIQUIDITY_FEE || "10000"),
  };
}

const FACTORY_OF_ABI = ["function factory() view returns (address)"];

/**
 * The CROQ economy: the plain token, its confidential wrapper and the Pantry, then the split
 * from the spec. Game reserve and welcome bags go into the Pantry; on a network with Uniswap V3,
 * the liquidity share opens a CROQ/USDC pool as a CROQ-only position, locked for good in the
 * LiquidityLocker; the rest stays with the collection owner.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get, execute, read } = hre.deployments;
  const { ethers } = hre;
  const { totalSupply, allocation } = economyFromSpec();

  const dno = await get("DoNotOpen");
  const croq = await deploy("Croq", { from: deployer, args: [totalSupply, deployer], log: true });
  const cCroq = await deploy("ConfidentialCroq", {
    from: deployer,
    args: [croq.address, process.env.CROQ_CONTRACT_URI || ""],
    log: true,
  });
  // The treasury's share of every meal goes to the collection owner.
  const treasury = process.env.COLLECTION_OWNER || deployer;
  const pantry = await deploy("Pantry", {
    from: deployer,
    args: [dno.address, cCroq.address, treasury, pantryParamsFromSpec()],
    log: true,
  });

  // The Pantry checks who holds a box, so the collection must trust it to ask.
  const owner_ = (await read("DoNotOpen", "owner")) as string;
  if (!((await read("DoNotOpen", "trustedReader", pantry.address)) as boolean)) {
    if (owner_.toLowerCase() === deployer.toLowerCase()) {
      await execute("DoNotOpen", { from: deployer, log: true }, "setTrustedReader", pantry.address, true);
    } else {
      console.log(`!! The collection owner ${owner_} must call DoNotOpen.setTrustedReader(${pantry.address}, true)`);
    }
  }

  if (pantry.newlyDeployed) {
    const reserve = allocation.gameReserve + allocation.welcomeBags;
    await execute("Croq", { from: deployer, log: true }, "approve", pantry.address, reserve);
    await execute("Pantry", { from: deployer, log: true }, "fund", reserve);
  }

  const uniswap = UNISWAP_V3[hre.network.name];
  if (uniswap) {
    const signer = await ethers.getSigner(deployer);
    for (const periphery of [uniswap.positionManager, uniswap.swapRouter, uniswap.quoter]) {
      const factory = await new ethers.Contract(periphery, FACTORY_OF_ABI, signer).factory!();
      if (factory !== uniswap.factory) throw new Error(`${periphery} does not belong to the Uniswap V3 factory ${uniswap.factory}`);
    }
    // CROQ trades against USDC, the collection's own currency.
    const usdcAddress = PAYMENT_TOKENS[hre.network.name]?.usdc;
    if (!usdcAddress) throw new Error(`no USDC known on ${hre.network.name}`);
    const { startPrice, rangeFactor, fee } = marketParams();
    // Holds the position for good; the fees it earns go to the treasury.
    const locker = await deploy("LiquidityLocker", {
      from: deployer,
      args: [uniswap.positionManager, treasury, process.env.COLLECTION_OWNER || deployer],
      log: true,
    });
    const held = (await read("LiquidityLocker", "positions")) as bigint[];
    const saved = await hre.deployments.getOrNull("CroqUsdcPool");
    if (held.length === 0 || !saved) {
      // Only CROQ goes in: the range starts at the pool's price, so buyers bring all the USDC.
      const plan = planSingleSided({
        croq: croq.address,
        quote: usdcAddress,
        croqDecimals: 0,
        quoteDecimals: 6,
        startPrice,
        rangeFactor,
        fee,
        croqAmount: allocation.liquidity,
      });
      const seeded = await seedSingleSided(signer, uniswap.positionManager, locker.address, plan, console.log);
      const startTick = plan.croqIsToken0 ? plan.tickLower : plan.tickUpper;
      const endTick = plan.croqIsToken0 ? plan.tickUpper : plan.tickLower;
      console.log(
        `CROQ/USDC pool  : ${seeded.pool} (${seeded.croqIn} CROQ, 0 USDC, ` +
          `${croqPriceAtTick(startTick, plan.croqIsToken0, 0, 6).toPrecision(4)} to ${croqPriceAtTick(endTick, plan.croqIsToken0, 0, 6).toPrecision(4)} USDC per CROQ)`,
      );
      await hre.deployments.save("CroqUsdcPool", {
        address: seeded.pool,
        abi: [],
        linkedData: {
          fee,
          positionId: seeded.positionId.toString(),
          tickLower: plan.tickLower,
          tickUpper: plan.tickUpper,
          croqIsToken0: plan.croqIsToken0,
        },
      });
    }
  }

  // The treasury goes to the owner, less the rats' pantry fund: rats.ts (next, alphabetically)
  // sends that from the deployer, so the pantry is funded in the same run whoever the owner is.
  const owner = process.env.COLLECTION_OWNER;
  if (owner && owner.toLowerCase() !== deployer.toLowerCase()) {
    const left = BigInt(String(await read("Croq", "balanceOf", deployer)));
    const ratPantry = await hre.deployments.getOrNull("RatPantry");
    const ratsHave = ratPantry ? BigInt(String(await read("Croq", "balanceOf", ratPantry.address))) : 0n;
    const fund = ratParamsFromSpec().fund;
    const keep = fund > ratsHave ? (fund - ratsHave < left ? fund - ratsHave : left) : 0n;
    if (left - keep > 0n) await execute("Croq", { from: deployer, log: true }, "transfer", owner, left - keep);
    if (keep > 0n) console.log(`kept ${keep} CROQ with the deployer for the rats' pantry (deploy/rats.ts sends them)`);
  }

  console.log(`Croq            : ${croq.address}`);
  console.log(`ConfidentialCroq: ${cCroq.address}`);
  console.log(`Pantry          : ${pantry.address} (treasury ${treasury})`);
};
export default func;
func.id = "deploy_economy";
func.tags = ["Economy"];
func.dependencies = ["DoNotOpen"];
