import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * The vault's pockets: cUSDC in pockets locked by a key, not an address (SealedPockets), and the
 * desk that buys the vault's private sales out of them (PocketDesk, which needs the vault).
 * Runs after the vault and redeploys nothing else: `--tags Pockets` adds them next to a live vault.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, execute, read } = hre.deployments;
  const owner = process.env.COLLECTION_OWNER || deployer!;
  const vault = await hre.deployments.get("SealedVault");
  const cUsdc = await read("SealedVault", "confidentialUsdc");

  // Owned by the deployer until the desk is set, then by the owner.
  const pockets = await deploy("SealedPockets", { from: deployer!, args: [cUsdc, deployer], log: true });
  const desk = await deploy("PocketDesk", { from: deployer!, args: [pockets.address, vault.address], log: true });
  if ((await read("SealedPockets", "desk")) === "0x0000000000000000000000000000000000000000") {
    await execute("SealedPockets", { from: deployer!, log: true }, "setDesk", desk.address);
  }
  if ((await read("SealedPockets", "owner")).toLowerCase() !== owner.toLowerCase()) {
    await execute("SealedPockets", { from: deployer!, log: true }, "transferOwnership", owner);
  }
  console.log(`SealedPockets: ${pockets.address} (cUSDC ${cUsdc}), PocketDesk: ${desk.address} (vault ${vault.address})`);
};
export default func;
func.id = "deploy_pockets";
func.tags = ["Pockets"];
func.dependencies = ["Vault"];
func.runAtTheEnd = true;
