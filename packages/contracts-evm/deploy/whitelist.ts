import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { whitelistParamsFromSpec } from "../lib/specParams";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const WRAPPER_ABI = ["function wrap(address to, uint256 amount)"];

/**
 * The whitelist's gifts: `WhitelistGifts`, made the boxes' and the rats' giver (both mint their
 * gifts free), then funded with the most cCROQ the tiers can draw, wrapped from the deployer's
 * CROQ when it holds them. The root is set later, when the list closes
 * (`hardhat dno:whitelist-root`).
 *
 * Runs after rats.ts (alphabetical order): it needs the collection, the CROQ economy and the rats.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get, read, execute } = hre.deployments;
  const { ethers } = hre;
  const owner = process.env.COLLECTION_OWNER || deployer;
  const w = whitelistParamsFromSpec();

  const dno = await get("DoNotOpen");
  const rats = await get("Rats");
  const cCroq = await get("ConfidentialCroq");
  const croq = await get("Croq");

  const gifts = await deploy("WhitelistGifts", { from: deployer, args: [dno.address, rats.address, cCroq.address, w.tiers, owner], log: true });

  for (const name of ["DoNotOpen", "Rats"]) {
    if (((await read(name, "giver")) as string).toLowerCase() === gifts.address.toLowerCase()) continue;
    const contractOwner = (await read(name, "owner")) as string;
    if (contractOwner.toLowerCase() === deployer.toLowerCase()) await execute(name, { from: deployer, log: true }, "setGiver", gifts.address);
    else console.log(`!! ${name}'s owner ${contractOwner} must call ${name}.setGiver(${gifts.address})`);
  }

  const signer = await ethers.getSigner(deployer);
  if (gifts.newlyDeployed) {
    // Croquettes: the most every tier can draw.
    const plain = new ethers.Contract(croq.address, ERC20_ABI, signer);
    if ((await plain.balanceOf!(deployer)) >= w.maxCroq) {
      await (await plain.approve!(cCroq.address, w.maxCroq)).wait();
      await (await new ethers.Contract(cCroq.address, WRAPPER_ABI, signer).wrap!(gifts.address, w.maxCroq)).wait();
      console.log(`WhitelistGifts funded with ${w.maxCroq} cCROQ`);
    } else {
      console.warn(`WhitelistGifts holds no cCROQ: wrap ${w.maxCroq} CROQ from the treasury to ${gifts.address} (ConfidentialCroq.wrap)`);
    }
  }
  console.log(`WhitelistGifts: ${gifts.address} (${w.places} places, ${w.tiers.length} tiers, up to ${w.maxCroq} cCROQ, ${w.boxes} boxes, ${w.rats} rats)`);
};
export default func;
func.id = "deploy_whitelist";
func.tags = ["Whitelist"];
func.dependencies = ["DoNotOpen", "Economy"];
