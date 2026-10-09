import { parseUnits } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { PAYMENT_TOKENS } from "../lib/paymentTokens";
import { configParamsFromSpec } from "../lib/specParams";

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

  // The token URIs, out of the collection: the API's metadata route unless BOXES_BASE_URI says otherwise.
  const baseURI = process.env.BOXES_BASE_URI || "https://api.do-not-open.app/metadata/";
  const metadata = await deploy("BoxMetadata", { from: deployer, args: [baseURI, owner], log: true });
  const { read, execute } = hre.deployments;
  if (((await read("DoNotOpen", "metadata")) as string).toLowerCase() !== metadata.address.toLowerCase()) {
    if (owner.toLowerCase() === deployer.toLowerCase()) await execute("DoNotOpen", { from: deployer, log: true }, "setMetadata", metadata.address);
    else console.log(`!! The collection's owner ${owner} must call DoNotOpen.setMetadata(${metadata.address})`);
  }

  // The confidential marketplace's hooks: refuse a sale whose box changed while in escrow.
  const hooks = await deploy("DoNotOpenHooks", { from: deployer, args: [dno.address], log: true });

  console.log(`spec hash       : ${params.specHash}`);
  console.log(`DoNotOpenConfig : ${config.address}`);
  console.log(`USDC / cUSDC    : ${payment.usdc} / ${payment.cUsdc}`);
  console.log(`DoNotOpen       : ${dno.address}`);
  console.log(`BoxMetadata     : ${metadata.address} (${baseURI})`);
  console.log(`DoNotOpenHooks  : ${hooks.address}`);
};
export default func;
func.id = "deploy_doNotOpen";
func.tags = ["DoNotOpen"];
