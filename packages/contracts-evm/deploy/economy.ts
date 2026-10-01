import { parseEther } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { economyFromSpec, pantryParamsFromSpec } from "../lib/specParams";

/** Uniswap V2 on Sepolia, from Uniswap's deployment list. Checked on-chain before use. */
export const UNISWAP_V2: Record<string, { router: string; factory: string; weth: string }> = {
  sepolia: {
    router: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3",
    factory: "0xF62c03E08ada871A0bEb309762E260a7a6a880E6",
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  },
};

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint, uint, uint)",
];
const FACTORY_ABI = ["function getPair(address, address) view returns (address)"];
const PAIR_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address, uint256) returns (bool)"];
/** LP tokens sent here are gone for good: the pool's liquidity can never be pulled. */
export const DEAD = "0x000000000000000000000000000000000000dEaD";

/**
 * The CROQ economy: the plain token, its confidential wrapper and the Pantry, then the split
 * from the spec. Game reserve and welcome bags go into the Pantry; on a network with Uniswap V2,
 * the liquidity share opens a CROQ/WETH pool; the rest stays with the collection owner.
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

  if (pantry.newlyDeployed) {
    const reserve = allocation.gameReserve + allocation.welcomeBags;
    await execute("Croq", { from: deployer, log: true }, "approve", pantry.address, reserve);
    await execute("Pantry", { from: deployer, log: true }, "fund", reserve);
  }

  const uniswap = UNISWAP_V2[hre.network.name];
  if (uniswap) {
    const signer = await ethers.getSigner(deployer);
    const router = new ethers.Contract(uniswap.router, ROUTER_ABI, signer);
    const factory = new ethers.Contract(uniswap.factory, FACTORY_ABI, signer);
    if ((await router.factory()) !== uniswap.factory || (await router.WETH()) !== uniswap.weth) {
      throw new Error("the Uniswap V2 router does not match the expected factory and WETH");
    }
    let pair: string = await factory.getPair(croq.address, uniswap.weth);
    if (pair === ethers.ZeroAddress) {
      const ethSide = parseEther(process.env.LIQUIDITY_ETH || "0.02");
      await execute("Croq", { from: deployer, log: true }, "approve", uniswap.router, allocation.liquidity);
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const tx = await router.addLiquidityETH(croq.address, allocation.liquidity, allocation.liquidity, ethSide, deployer, deadline, {
        value: ethSide,
      });
      await tx.wait();
      pair = await factory.getPair(croq.address, uniswap.weth);
      console.log(`CROQ/WETH pool  : ${pair} (${allocation.liquidity} CROQ + ${ethers.formatEther(ethSide)} ETH)`);
    }
    // Lock the liquidity: nobody, the deployer included, can take it back out.
    const lp = new ethers.Contract(pair, PAIR_ABI, signer);
    const held: bigint = await lp.balanceOf(deployer);
    if (held > 0n) {
      await (await lp.transfer(DEAD, held)).wait();
      console.log(`LP tokens       : ${held} sent to ${DEAD}`);
    }
    await hre.deployments.save("CroqWethPair", { address: pair, abi: [] });
  }

  const owner = process.env.COLLECTION_OWNER;
  if (owner && owner.toLowerCase() !== deployer.toLowerCase()) {
    const left = (await read("Croq", "balanceOf", deployer)) as bigint;
    if (left > 0n) await execute("Croq", { from: deployer, log: true }, "transfer", owner, left);
  }

  console.log(`Croq            : ${croq.address}`);
  console.log(`ConfidentialCroq: ${cCroq.address}`);
  console.log(`Pantry          : ${pantry.address} (treasury ${treasury})`);
};
export default func;
func.id = "deploy_economy";
func.tags = ["Economy"];
func.dependencies = ["DoNotOpen"];
