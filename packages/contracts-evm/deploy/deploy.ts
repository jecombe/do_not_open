import { parseUnits } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { configParamsFromSpec } from "../lib/specParams";

/** USDC and its confidential ERC-7984 wrapper, per network. From Zama's list of testnet tokens. */
export const PAYMENT_TOKENS: Record<string, { usdc: string; cUsdc: string }> = {
  sepolia: {
    usdc: "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF",
    cUsdc: "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639",
  },
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  if (!deployer) throw new Error("No deployer account. Set MNEMONIC or PRIVATE_KEY in .env (see .env.example).");
  const { deploy } = hre.deployments;

  const params = configParamsFromSpec();
  const config = await deploy("DoNotOpenConfig", { from: deployer, args: [params], log: true });

  // Prices are in USDC's smallest unit (6 decimals).
  const usd = (name: string, fallback: string) => parseUnits(process.env[name] || fallback, 6);
  const fees = {
    mint: usd("MINT_PRICE_USDC", "5"),
    observe: usd("OBSERVE_FEE_USDC", "1"),
    feed: usd("FEED_FEE_USDC", "0.5"),
    paidShake: usd("PAID_SHAKE_FEE_USDC", "2.5"),
  };
  const owner = process.env.COLLECTION_OWNER || deployer;

  // Zama's test dollars on Sepolia, anyone can mint the plain one. Elsewhere, local stand-ins.
  let payment = PAYMENT_TOKENS[hre.network.name];
  if (!payment) {
    const usdc = await deploy("TestUSDC", { from: deployer, log: true });
    const cUsdc = await deploy("TestConfidentialUSDC", { from: deployer, args: [usdc.address], log: true });
    payment = { usdc: usdc.address, cUsdc: cUsdc.address };
  }

  const dno = await deploy("DoNotOpen", {
    from: deployer,
    args: [config.address, fees, payment.usdc, payment.cUsdc, owner],
    log: true,
  });

  console.log(`spec hash       : ${params.specHash}`);
  console.log(`DoNotOpenConfig : ${config.address}`);
  console.log(`USDC / cUSDC    : ${payment.usdc} / ${payment.cUsdc}`);
  console.log(`DoNotOpen       : ${dno.address}`);
};
export default func;
func.id = "deploy_doNotOpen";
func.tags = ["DoNotOpen"];
