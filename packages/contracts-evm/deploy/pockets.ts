import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { POCKET_TOKENS, pocketsDeployment } from "../lib/pocketTokens";

/**
 * The vault's pockets: cUSDC in pockets locked by a key, not an address (SealedPockets), and the
 * desk that buys the vault's private sales out of them (PocketDesk, which needs the vault).
 * Then one SealedPockets for each of Zama's other confidential tokens on the network
 * (lib/pocketTokens.ts: cUSDT, cWETH, cZAMA on Sepolia), without a desk. A local network gets a
 * test cWETH (an 18-decimal ERC-20 and its wrapper), so liquidity positions have a pair there too.
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
  if (!(await read("SealedPockets", "isDesk", desk.address))) {
    await execute("SealedPockets", { from: deployer!, log: true }, "addDesk", desk.address);
  }
  if ((await read("SealedPockets", "owner")).toLowerCase() !== owner.toLowerCase()) {
    await execute("SealedPockets", { from: deployer!, log: true }, "transferOwnership", owner);
  }
  console.log(`SealedPockets: ${pockets.address} (cUSDC ${cUsdc}), PocketDesk: ${desk.address} (vault ${vault.address})`);

  const others = POCKET_TOKENS[hre.network.name] ?? [];
  if (hre.network.config.chainId === 31337 && !others.length) {
    const weth = await deploy("TestERC20_WETH", { contract: "TestERC20", from: deployer!, args: ["Wrapped Ether (Test)", "WETH", 18], log: true });
    const cWeth = await deploy("TestConfidentialToken_cWETH", { contract: "TestConfidentialToken", from: deployer!, args: [weth.address, "Confidential WETH (Test)", "cWETH"], log: true });
    others.push({ symbol: "cWETH", token: cWeth.address });
  }
  for (const { symbol, token } of others) {
    const more = await deploy(pocketsDeployment(symbol), { contract: "SealedPockets", from: deployer!, args: [token, owner], log: true });
    console.log(`SealedPockets (${symbol}): ${more.address} (token ${token})`);
  }
};
export default func;
func.id = "deploy_pockets";
func.tags = ["Pockets"];
func.dependencies = ["Vault"];
func.runAtTheEnd = true;
