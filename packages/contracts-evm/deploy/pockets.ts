import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { POCKET_TOKENS, POCKETS_MAX_SET, pocketsDeployment } from "../lib/pocketTokens";
import { SAVINGS_BATCHERS, TEST_DEPOSIT_RATE, TEST_REDEEM_RATE, TEST_SHARE_PRICE } from "../lib/savings";
import { STEALTH } from "../lib/stealth";

/**
 * The vault's pockets: cUSDC in pockets locked by a key, not an address (SealedPockets), the
 * desk that buys the vault's private sales out of them (PocketDesk, which needs the vault), and
 * the savings that put a pocket's cUSDC to work in one of Zama's confidential vaults on Morpho
 * (PocketSavings, on the batchers of lib/savings.ts; test batchers, a test share and a test
 * yield vault on a local network, funded to pay their claims).
 * Then one SealedPockets for each of Zama's other confidential tokens on the network
 * (lib/pocketTokens.ts: cUSDT, cWETH, cZAMA on Sepolia), without a desk. The pockets' exits go
 * to stealth addresses through ERC-5564's announcer and ERC-6538's registry (lib/stealth.ts),
 * deployed once for everyone on Sepolia and mainnet; a local network gets test ones.
 * Runs after the vault and redeploys nothing else: `--tags Pockets` adds them next to a live vault.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, execute, read } = hre.deployments;
  const owner = process.env.COLLECTION_OWNER || deployer!;
  const vault = await hre.deployments.get("SealedVault");
  const cUsdc = await read("SealedVault", "confidentialUsdc");

  // Owned by the deployer until the desk is set, then by the owner.
  const pockets = await deploy("SealedPockets", { from: deployer!, args: [cUsdc, deployer, POCKETS_MAX_SET], log: true });
  const desk = await deploy("PocketDesk", { from: deployer!, args: [pockets.address, vault.address], log: true });
  if ((await read("SealedPockets", "desk")) === "0x0000000000000000000000000000000000000000") {
    await execute("SealedPockets", { from: deployer!, log: true }, "setDesk", desk.address);
  }

  // The savings, on Zama's batchers where they are, on test ones elsewhere.
  let batchers = SAVINGS_BATCHERS[hre.network.name];
  if (!batchers) {
    const usdc = await hre.deployments.get("TestUSDC");
    const yieldVault = await deploy("TestYieldVault", { from: deployer!, args: [usdc.address, TEST_SHARE_PRICE], log: true });
    const share = await deploy("TestConfidentialShare", { from: deployer!, args: [yieldVault.address], log: true });
    const depositBatcher = await deploy("TestVaultBatcher_deposit", { contract: "TestVaultBatcher", from: deployer!, args: [yieldVault.address, cUsdc, share.address, TEST_DEPOSIT_RATE, 0], log: true });
    const redeemBatcher = await deploy("TestVaultBatcher_redeem", { contract: "TestVaultBatcher", from: deployer!, args: [yieldVault.address, share.address, cUsdc, TEST_REDEEM_RATE, 0], log: true });
    if (depositBatcher.newlyDeployed) {
      // The test batchers pay their claims from their own balances: shares for the deposits, cUSDC for the redeems.
      const fund = 1_000_000n * 10n ** 6n;
      await execute("TestConfidentialShare", { from: deployer!, log: true }, "mint", depositBatcher.address, fund);
      await execute("TestUSDC", { from: deployer!, log: true }, "mint", deployer, fund);
      await execute("TestUSDC", { from: deployer!, log: true }, "approve", cUsdc, fund);
      await execute("TestConfidentialUSDC", { from: deployer!, log: true }, "wrap", redeemBatcher.address, fund);
    }
    batchers = { vault: "test", depositBatcher: depositBatcher.address, redeemBatcher: redeemBatcher.address };
  }
  const savings = await deploy("PocketSavings", { from: deployer!, args: [pockets.address, batchers.depositBatcher, batchers.redeemBatcher], log: true });
  if ((await read("SealedPockets", "savings")) === "0x0000000000000000000000000000000000000000") {
    await execute("SealedPockets", { from: deployer!, log: true }, "setSavings", savings.address);
  }
  if ((await read("SealedPockets", "owner")).toLowerCase() !== owner.toLowerCase()) {
    await execute("SealedPockets", { from: deployer!, log: true }, "transferOwnership", owner);
  }
  console.log(`SealedPockets: ${pockets.address} (cUSDC ${cUsdc}, groups of ${POCKETS_MAX_SET}), PocketDesk: ${desk.address} (vault ${vault.address}), PocketSavings: ${savings.address} (${batchers.vault})`);

  if (!STEALTH[hre.network.name]) {
    await deploy("TestStealthAnnouncer", { from: deployer!, args: [], log: true });
    await deploy("TestStealthRegistry", { from: deployer!, args: [], log: true });
  }

  for (const { symbol, token } of POCKET_TOKENS[hre.network.name] ?? []) {
    const more = await deploy(pocketsDeployment(symbol), { contract: "SealedPockets", from: deployer!, args: [token, owner, POCKETS_MAX_SET], log: true });
    console.log(`SealedPockets (${symbol}): ${more.address} (token ${token})`);
  }
};
export default func;
func.id = "deploy_pockets";
func.tags = ["Pockets"];
func.dependencies = ["Vault"];
func.runAtTheEnd = true;
