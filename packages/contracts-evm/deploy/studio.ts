import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { studioPacksFromSpec } from "../lib/studioPacks";
import { PAYMENT_TOKENS } from "../lib/paymentTokens";

/**
 * The studio's packs, sold in plain USDC before any AI generation, with the packs of
 * packages/game-spec/studio.json. Payments go straight to the treasury (the collection's owner
 * unless STUDIO_TREASURY says otherwise). Change a pack later with `setPack`, without redeploying.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;
  const owner = process.env.COLLECTION_OWNER || deployer;
  const treasury = process.env.STUDIO_TREASURY || owner;
  const usdc = PAYMENT_TOKENS[hre.network.name]?.usdc ?? (await get("TestUSDC")).address;
  const packs = studioPacksFromSpec();

  const studio = await deploy("StudioPacks", { from: deployer, args: [usdc, treasury, owner, packs], log: true });
  const list = packs.map((p, i) => `#${i} ${hre.ethers.formatUnits(p.price, 6)} USDC`).join(", ");
  console.log(`StudioPacks: ${studio.address} (${list})`);
};
export default func;
func.id = "deploy_studio";
func.tags = ["Studio"];
func.dependencies = ["DoNotOpen"];
