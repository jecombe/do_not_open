import { parseUnits } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { PAYMENT_TOKENS } from "./deploy";

/**
 * Decryption credits: what a wallet buys, in plain USDC, once its free daily allowance of
 * decryptions is spent. Payments go straight to the treasury (the collection's owner unless
 * CREDITS_TREASURY says otherwise).
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;
  const owner = process.env.COLLECTION_OWNER || deployer;
  const treasury = process.env.CREDITS_TREASURY || owner;
  const price = parseUnits(process.env.CREDIT_PRICE_USDC || "0.01", 6);
  const usdc = PAYMENT_TOKENS[hre.network.name]?.usdc ?? (await get("TestUSDC")).address;

  const credits = await deploy("DecryptionCredits", { from: deployer, args: [usdc, price, treasury, owner], log: true });
  console.log(`DecryptionCredits: ${credits.address} (${hre.ethers.formatUnits(price, 6)} USDC a credit)`);
};
export default func;
func.id = "deploy_credits";
func.tags = ["Credits"];
func.dependencies = ["DoNotOpen"];
