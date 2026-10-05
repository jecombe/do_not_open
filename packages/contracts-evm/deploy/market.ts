import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { marketParamsFromSpec } from "../lib/marketParams";
import { PAYMENT_TOKENS } from "./deploy";

/**
 * The flea market: boxes, cats and rats sold between players, in cUSDC, with the fee of
 * packages/game-spec/spec.json going to the treasury (STUDIO_TREASURY, or the collection's
 * owner). Needs the collection, its DoNotOpenHooks and the Rats on this network.
 *
 * Runs after every other script (`runAtTheEnd`), and lists no dependency: the collection, its
 * hooks and the rats are only looked up, never redeployed, so `--tags Market` adds the market
 * next to a live collection.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get } = hre.deployments;
  const owner = process.env.COLLECTION_OWNER || deployer;
  const treasury = process.env.STUDIO_TREASURY || owner;
  const cUsdc = PAYMENT_TOKENS[hre.network.name]?.cUsdc ?? (await get("TestConfidentialUSDC")).address;
  const [dno, hooks, rats] = await Promise.all([get("DoNotOpen"), get("DoNotOpenHooks"), get("Rats")]);
  const { feeBps } = marketParamsFromSpec();

  const market = await deploy("FleaMarket", { from: deployer, args: [dno.address, hooks.address, rats.address, cUsdc, treasury, owner, feeBps], log: true });
  console.log(`FleaMarket: ${market.address} (fee ${feeBps / 100}% to ${treasury})`);
};
export default func;
func.id = "deploy_market";
func.tags = ["Market"];
func.runAtTheEnd = true;
