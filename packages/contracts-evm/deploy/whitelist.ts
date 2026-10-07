import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { whitelistParamsFromSpec } from "../lib/specParams";
import { PAYMENT_TOKENS } from "./deploy";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function mint(address,uint256)"];
const WRAPPER_ABI = ["function wrap(address to, uint256 amount)"];

/**
 * The whitelist's gifts: `WhitelistGifts`, made the rats' giver, then funded so every seat can
 * collect its gift. cCROQ: the most the tiers can draw, wrapped from the deployer's CROQ when it
 * holds them. cUSDC: one mint price per gift box; on a test network the plain test USDC is minted
 * and wrapped here, elsewhere the script says what to send. The root is set later, when the list
 * closes (`hardhat dno:whitelist-root`).
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
  const testUsdc = await hre.deployments.getOrNull("TestUSDC");
  const payment = PAYMENT_TOKENS[hre.network.name] ?? { usdc: testUsdc!.address, cUsdc: (await get("TestConfidentialUSDC")).address };

  const gifts = await deploy("WhitelistGifts", { from: deployer, args: [dno.address, rats.address, cCroq.address, payment.cUsdc, w.tiers, owner], log: true });

  const ratsOwner = (await read("Rats", "owner")) as string;
  if (((await read("Rats", "giver")) as string).toLowerCase() !== gifts.address.toLowerCase()) {
    if (ratsOwner.toLowerCase() === deployer.toLowerCase()) await execute("Rats", { from: deployer, log: true }, "setGiver", gifts.address);
    else console.log(`!! The rats' owner ${ratsOwner} must call Rats.setGiver(${gifts.address})`);
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
    // Boxes: one mint price each.
    const mintPrice = BigInt(String(await read("DoNotOpen", "mintPrice")));
    const dollars = mintPrice * BigInt(w.boxes);
    if (hre.network.name !== "mainnet") {
      const usdc = new ethers.Contract(payment.usdc, ERC20_ABI, signer);
      await (await usdc.mint!(deployer, dollars)).wait();
      await (await usdc.approve!(payment.cUsdc, dollars)).wait();
      await (await new ethers.Contract(payment.cUsdc, WRAPPER_ABI, signer).wrap!(gifts.address, dollars)).wait();
      console.log(`WhitelistGifts funded with ${ethers.formatUnits(dollars, 6)} test cUSDC`);
    } else {
      console.warn(`WhitelistGifts holds no cUSDC: wrap ${ethers.formatUnits(dollars, 6)} USDC to ${gifts.address} for its ${w.boxes} boxes`);
    }
  }
  console.log(`WhitelistGifts: ${gifts.address} (${w.places} places, ${w.tiers.length} tiers, up to ${w.maxCroq} cCROQ, ${w.boxes} boxes, ${w.rats} rats)`);
};
export default func;
func.id = "deploy_whitelist";
func.tags = ["Whitelist"];
func.dependencies = ["DoNotOpen", "Economy"];
