import type { InterfaceAbi } from "ethers";
import sepoliaDeployment from "./deployments/sepolia.json";
import sepoliaEconomy from "./deployments/sepolia-economy.json";
import type { EconomyDeployment } from "./EvmFhevmAdapter";
import type { ChainParams } from "./wallet";

export interface Deployment {
  chainId: number;
  address: string;
  /** Block the contract was deployed in. */
  deployBlock: number;
  abi: InterfaceAbi;
  /** ETH in, USDC or cUSDC out. Null where none was deployed. */
  ramp?: { address: string; abi: InterfaceAbi } | null;
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
