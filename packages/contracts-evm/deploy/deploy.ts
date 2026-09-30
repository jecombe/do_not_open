import { parseEther } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { configParamsFromSpec } from "../lib/specParams";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  if (!deployer) throw new Error("No deployer account. Set MNEMONIC or PRIVATE_KEY in .env (see .env.example).");
  const { deploy } = hre.deployments;

  const params = configParamsFromSpec();
  const config = await deploy("DoNotOpenConfig", { from: deployer, args: [params], log: true });

  const mintPrice = parseEther(process.env.MINT_PRICE_ETH || "0.002");
  const observeFee = parseEther(process.env.OBSERVE_FEE_ETH || "0.0005");
  const owner = process.env.COLLECTION_OWNER || deployer;

  const dno = await deploy("DoNotOpen", {
    from: deployer,
    args: [config.address, mintPrice, observeFee, owner],
    log: true,
  });

  console.log(`spec hash       : ${params.specHash}`);
  console.log(`DoNotOpenConfig : ${config.address}`);
  console.log(`DoNotOpen       : ${dno.address}`);
};
export default func;
func.id = "deploy_doNotOpen";
func.tags = ["DoNotOpen"];
