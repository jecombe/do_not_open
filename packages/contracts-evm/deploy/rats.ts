import { Wallet } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ratParamsFromSpec } from "../lib/ratParams";
import { PAYMENT_TOKENS } from "../lib/paymentTokens";

/**
 * The depot's rats: the `Rats` ERC-721, sold in plain USDC to the treasury (STUDIO_TREASURY, or
 * the collection's owner), and the `RatPantry`, which pays each rat its daily CROQ. The pantry is
 * funded here with the spec's `fund`, from whichever key holds the CROQ: the deployer, or the
 * treasury's own key in TREASURY_PRIVATE_KEY. With neither, it is deployed empty and says how
 * much to send it: a plain CROQ transfer from the treasury's wallet does it (claims revert until then). AI rats are signed by RATS_ATTESTER (the API's key,
 * RATS_ATTESTER_KEY on the server); RATS_BASE_URI is where the metadata is served.
 *
 * Runs after economy.ts (alphabetical order) and lists no dependency, so `--tags Rats` deploys
 * the rats alone without looking at the collection again.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get, getOrNull } = hre.deployments;
  const owner = process.env.COLLECTION_OWNER || deployer;
  const treasury = process.env.STUDIO_TREASURY || owner;
  const attester = process.env.RATS_ATTESTER || deployer;
  const baseURI = process.env.RATS_BASE_URI || "https://api.do-not-open.app/rats/";
  const usdc = PAYMENT_TOKENS[hre.network.name]?.usdc ?? (await get("TestUSDC")).address;
  const croqDeployment = await getOrNull("Croq");
  if (!croqDeployment) throw new Error("no Croq deployment on this network: deploy the economy first");
  const p = ratParamsFromSpec();

  const rats = await deploy("Rats", { from: deployer, args: [usdc, treasury, owner, attester, p.seedPrice, p.modelPrice, baseURI, [p.maxSeedRats, p.maxModelRats, p.maxPerWallet, p.maxGiftRats], p.powerBelow], log: true });
  const pantry = await deploy("RatPantry", { from: deployer, args: [croqDeployment.address, rats.address, p.perDay, p.maxDays], log: true });

  // Fund the pantry up to the spec's amount, from the deployer or the treasury's key.
  const croq = await hre.ethers.getContractAt("Croq", croqDeployment.address);
  const have: bigint = await croq.balanceOf(pantry.address);
  const missing = p.fund > have ? p.fund - have : 0n;
  if (missing > 0n) {
    const signers = [await hre.ethers.getSigner(deployer)];
    if (process.env.TREASURY_PRIVATE_KEY) signers.push(new Wallet(process.env.TREASURY_PRIVATE_KEY, hre.ethers.provider) as never);
    let funded = false;
    for (const signer of signers) {
      if ((await croq.balanceOf(await signer.getAddress())) >= missing) {
        await (await croq.connect(signer).transfer(pantry.address, missing)).wait();
        console.log(`RatPantry funded with ${missing} CROQ from ${await signer.getAddress()}`);
        funded = true;
        break;
      }
    }
    if (!funded) {
      // Not fatal: claims revert while the pantry is empty, so nobody loses a day meanwhile.
      console.warn(`RatPantry ${pantry.address} is EMPTY: send it ${missing} CROQ with a plain transfer from the treasury's wallet`);
    }
  }
  console.log(`Rats: ${rats.address} (seed rat ${hre.ethers.formatUnits(p.seedPrice, 6)} USDC, AI rat ${hre.ethers.formatUnits(p.modelPrice, 6)} USDC, at most ${p.maxSeedRats} + ${p.maxModelRats} rats and ${p.maxPerWallet} a wallet, ${p.maxGiftRats} gift rats, attester ${attester})`);
  console.log(`RatPantry: ${pantry.address} (${p.perDay} CROQ a rat a day, ${p.maxDays} days kept)`);
};
export default func;
func.id = "deploy_rats";
func.tags = ["Rats"];
