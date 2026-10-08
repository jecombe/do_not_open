import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import seaportFixture from "../test/fixtures/seaport-1.5.json";
import { PAYMENT_TOKENS } from "./deploy";

/** Seaport 1.5, where OpenSea deployed it on every chain it supports. */
export const SEAPORT = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";

/**
 * The sealed vault: any NFT of an allowed collection, its holder encrypted, sold on Seaport with
 * the vault as the seller, or privately in cUSDC. On a test network it also deploys
 * VaultTestNFT, free to mint, and allows it.
 *
 * Seaport is OpenSea's own deployment on Sepolia; on a local node (`pnpm chain`) its Sepolia
 * code is put at the same address first. The fee (VAULT_FEE_BPS, 2.5% by default) goes to
 * STUDIO_TREASURY, or the owner. Runs at the end and redeploys nothing else: `--tags Vault`
 * adds the vault next to a live collection.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, execute, read } = hre.deployments;
  const owner = process.env.COLLECTION_OWNER || deployer!;
  const treasury = process.env.STUDIO_TREASURY || owner;
  const feeBps = Number(process.env.VAULT_FEE_BPS ?? 250);
  // Local networks pay in the test cUSDC the collection's script deploys (reused if it ran).
  const cUsdc =
    PAYMENT_TOKENS[hre.network.name]?.cUsdc ??
    (await deploy("TestConfidentialUSDC", { from: deployer!, args: [(await deploy("TestUSDC", { from: deployer!, log: true })).address], log: true })).address;

  if ((await hre.ethers.provider.getCode(SEAPORT)) === "0x") {
    if (hre.network.config.chainId !== 31337) throw new Error(`No Seaport at ${SEAPORT} on ${hre.network.name}.`);
    for (const { address, code } of [seaportFixture.seaport, seaportFixture.conduitController]) {
      await hre.network.provider.send("hardhat_setCode", [address, code]);
    }
    for (const [slot, value] of Object.entries(seaportFixture.seaport.storage)) {
      await hre.network.provider.send("hardhat_setStorageAt", [SEAPORT, slot, value]);
    }
    console.log(`Seaport 1.5 put at ${SEAPORT} (Sepolia's code)`);
  }

  // Owned by the deployer until the test collection is allowed, then by the owner.
  const vault = await deploy("SealedVault", { from: deployer!, args: [SEAPORT, cUsdc, treasury, deployer, feeBps], log: true });
  if (hre.network.name !== "mainnet") {
    const nft = await deploy("VaultTestNFT", { from: deployer!, log: true });
    if (!(await read("SealedVault", "allowedCollection", nft.address))) {
      await execute("SealedVault", { from: deployer!, log: true }, "setCollection", nft.address, true);
    }
  }
  if ((await read("SealedVault", "owner")).toLowerCase() !== owner.toLowerCase()) {
    await execute("SealedVault", { from: deployer!, log: true }, "transferOwnership", owner);
  }
  console.log(`SealedVault: ${vault.address} (fee ${feeBps / 100}% to ${treasury}, Seaport ${SEAPORT})`);
};
export default func;
func.id = "deploy_vault";
func.tags = ["Vault"];
func.runAtTheEnd = true;
