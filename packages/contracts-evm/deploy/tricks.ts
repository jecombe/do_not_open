import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ratParamsFromSpec } from "../lib/ratParams";
import { PAYMENT_TOKENS } from "../lib/paymentTokens";

const ERC20_ABI = ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"];
const CUSDC_ABI = ["function wrap(address to, uint256 amount)", "function setOperator(address operator, uint48 until)", "function isOperator(address holder, address spender) view returns (bool)"];

/**
 * The rats' tricks: `RatTricks`, then wired in. DoNotOpen passes every shake through it
 * (`setGuard`) and lets it ask `isOwner` (`setTrustedReader`); Rats lets it read the powers
 * (`setTricks`). Each step is the contract owner's: done here when the deployer owns it, printed
 * otherwise. Power-1 rebates come from the treasury's cUSDC (TRICKS_REBATER, or the collection's
 * owner) once it made RatTricks its operator; on a test network the deployer does so and gets
 * some test cUSDC to pay them.
 *
 * Runs after rats.ts (alphabetical order).
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get, getOrNull, read, execute } = hre.deployments;
  const { ethers } = hre;
  const owner = process.env.COLLECTION_OWNER || deployer;
  const rebater = process.env.TRICKS_REBATER || owner;
  const p = ratParamsFromSpec();

  const dno = await get("DoNotOpen");
  const rats = await get("Rats");
  const config = await get("DoNotOpenConfig");
  const testUsdc = await getOrNull("TestUSDC");
  const payment = PAYMENT_TOKENS[hre.network.name] ?? { usdc: testUsdc!.address, cUsdc: (await get("TestConfidentialUSDC")).address };
  const fee = BigInt(String(await read("DoNotOpen", "paidShakeFee")));
  const rebate = (fee * BigInt(p.sniffRebateBps)) / 10_000n;

  const tricks = await deploy("RatTricks", {
    from: deployer,
    args: [dno.address, rats.address, payment.cUsdc, config.address, rebate, p.trickSeconds, p.rechargeSeconds, rebater, owner],
    log: true,
  });

  const asOwner = async (contract: string, check: () => Promise<boolean>, method: string, ...args: unknown[]) => {
    if (await check()) return;
    const contractOwner = (await read(contract, "owner")) as string;
    if (contractOwner.toLowerCase() === deployer.toLowerCase()) await execute(contract, { from: deployer, log: true }, method, ...args);
    else console.log(`!! The owner ${contractOwner} of ${contract} must call ${method}(${args.join(", ")})`);
  };
  const same = (a: string) => a.toLowerCase() === tricks.address.toLowerCase();
  await asOwner("DoNotOpen", async () => same((await read("DoNotOpen", "guard")) as string), "setGuard", tricks.address);
  await asOwner("DoNotOpen", async () => (await read("DoNotOpen", "trustedReader", tricks.address)) as boolean, "setTrustedReader", tricks.address, true);
  await asOwner("Rats", async () => same((await read("Rats", "tricks")) as string), "setTricks", tricks.address);

  const signer = await ethers.getSigner(deployer);
  const cUsdc = new ethers.Contract(payment.cUsdc, CUSDC_ABI, signer);
  if (rebater.toLowerCase() === deployer.toLowerCase() && !(await cUsdc.isOperator!(deployer, tricks.address))) {
    await (await cUsdc.setOperator!(tricks.address, 2n ** 48n - 1n)).wait();
    if (hre.network.name !== "mainnet" && testUsdc) {
      const amount = 1_000_000_000n; // 1,000 test USDC of rebates
      const usdc = new ethers.Contract(payment.usdc, ERC20_ABI, signer);
      await (await usdc.mint!(deployer, amount)).wait();
      await (await usdc.approve!(payment.cUsdc, amount)).wait();
      await (await cUsdc.wrap!(deployer, amount)).wait();
    }
  } else if (rebater.toLowerCase() !== deployer.toLowerCase()) {
    console.log(`!! The rebater ${rebater} must call cUSDC.setOperator(${tricks.address}, until) for power-1 rebates`);
  }
  console.log(`RatTricks: ${tricks.address} (sniff ${ethers.formatUnits(fee, 6)} cUSDC, ${ethers.formatUnits(rebate, 6)} back for power 1, tricks ${p.trickSeconds / 86_400} d, rest ${p.rechargeSeconds / 86_400} d, rebater ${rebater})`);
};
export default func;
func.id = "deploy_tricks";
func.tags = ["Tricks"];
func.dependencies = ["DoNotOpen", "Rats"];
