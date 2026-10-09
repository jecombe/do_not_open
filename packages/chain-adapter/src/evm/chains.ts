import type { InterfaceAbi } from "ethers";
import sepoliaDeployment from "./deployments/sepolia.json";
import sepoliaEconomy from "./deployments/sepolia-economy.json";
import type { EconomyDeployment } from "./EvmFhevmAdapter";
import type { VaultDeployment } from "./EvmVault";
import type { ChainParams } from "./wallet";

export interface Deployment {
  chainId: number;
  address: string;
  /** Block the contract was deployed in. */
  deployBlock: number;
  abi: InterfaceAbi;
  /** ETH in, USDC or cUSDC out. Null where none was deployed. */
  ramp?: { address: string; abi: InterfaceAbi } | null;
  /** Decryption credits, bought in USDC past the free daily allowance. Null where none was deployed. */
  credits?: { address: string; abi: InterfaceAbi; deployBlock?: number | null } | null;
  /** The studio's packs, bought in USDC before any AI generation. Null where none was deployed. */
  studio?: { address: string; abi: InterfaceAbi; deployBlock?: number | null } | null;
  /** The depot's rats (ERC-721) and the pantry that pays them CROQ. Null where none was deployed. */
  rats?: { address: string; abi: InterfaceAbi; deployBlock?: number | null } | null;
  ratPantry?: { address: string; abi: InterfaceAbi; deployBlock?: number | null } | null;
  /** The flea market, where players sell each other boxes, cats and rats. Null where none was deployed. */
  market?: { address: string; abi: InterfaceAbi; deployBlock?: number | null } | null;
  /** The whitelist's gifts. Absent until they are deployed (mainnet). */
  whitelistGifts?: { address: string; abi: InterfaceAbi } | null;
  /** The rats' tricks. Absent until deployed. */
  ratTricks?: { address: string; abi: InterfaceAbi; deployBlock?: number | null } | null;
  /** The sealed vault, where any NFT can sit with its holder hidden. Absent until deployed. */
  vault?: VaultDeployment | null;
}

export const SEPOLIA: ChainParams = {
  chainId: 11155111,
  name: "Sepolia",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorerUrl: "https://sepolia.etherscan.io",
  currency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
};

/** Written by `pnpm --filter @dno/contracts-evm export:sepolia` after each deploy. */
export const SEPOLIA_DEPLOYMENT = sepoliaDeployment as Deployment;

/** The croquette economy next to it, written by the same export. */
export const SEPOLIA_ECONOMY = sepoliaEconomy as EconomyDeployment;
