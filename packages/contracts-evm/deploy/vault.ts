import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import registryFixture from "../test/fixtures/delegate-registry-v2.json";
import seaportFixture from "../test/fixtures/seaport-1.5.json";
import { PAYMENT_TOKENS } from "./deploy";

/** Seaport 1.5, where OpenSea deployed it on every chain it supports. */
export const SEAPORT = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";

/** delegate.xyz's Delegate Registry v2, at the same address on every chain it is on. */
export const DELEGATE_REGISTRY = "0x00000000000000447e69651d841bD8D104Bed493";

/** The WETH Seaport offers pay in: OpenSea's on each network. Local networks deploy a test one. */
export const WETH: Record<string, string> = {
  mainnet: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  sepolia: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
};

/**
 * The sealed vault: any NFT of an allowed collection, its holder encrypted, sold on Seaport with
 * the vault as the seller (a listing, or a buyer's offer accepted through VaultOffers, deployed
 * first), or privately in cUSDC, and delegated through delegate.xyz. On a test network it also
 * deploys VaultTestNFT, free to mint, and allows it.
 *
 * Seaport and delegate.xyz's registry are the live deployments on Sepolia; on a local node
 * (`pnpm chain`) their Sepolia code is put at the same addresses first, and a test WETH is
 * deployed. The fee (VAULT_FEE_BPS, 2.5% by default) goes to
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
  if ((await hre.ethers.provider.getCode(DELEGATE_REGISTRY)) === "0x") {
    if (hre.network.config.chainId !== 31337) throw new Error(`No delegate.xyz registry at ${DELEGATE_REGISTRY} on ${hre.network.name}.`);
    await hre.network.provider.send("hardhat_setCode", [DELEGATE_REGISTRY, registryFixture.code]);
    console.log(`delegate.xyz's registry put at ${DELEGATE_REGISTRY} (Sepolia's code)`);
  }
  const weth = WETH[hre.network.name] ?? (await deploy("TestWETH", { from: deployer!, log: true })).address;
  const offers = await deploy("VaultOffers", { from: deployer!, args: [SEAPORT, weth], log: true });

  // Owned by the deployer until the test collection is allowed, then by the owner.
  const vault = await deploy("SealedVault", { from: deployer!, args: [SEAPORT, cUsdc, offers.address, DELEGATE_REGISTRY, treasury, deployer, feeBps], log: true });
  if (hre.network.name !== "mainnet") {
    const nft = await deploy("VaultTestNFT", { from: deployer!, log: true });
    if (!(await read("SealedVault", "allowedCollection", nft.address))) {
      await execute("SealedVault", { from: deployer!, log: true }, "setCollection", nft.address, true);
    }
  }
  if ((await read("SealedVault", "owner")).toLowerCase() !== owner.toLowerCase()) {
    await execute("SealedVault", { from: deployer!, log: true }, "transferOwnership", owner);
  }
  console.log(`SealedVault: ${vault.address} (fee ${feeBps / 100}% to ${treasury}, Seaport ${SEAPORT}, offers ${offers.address}, WETH ${weth})`);
};
export default func;
func.id = "deploy_vault";
func.tags = ["Vault"];
func.runAtTheEnd = true;
