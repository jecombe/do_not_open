import { SEPOLIA, SEPOLIA_DEPLOYMENT, SEPOLIA_ECONOMY } from "@dno/chain-adapter/deployments";
import type { InterfaceAbi } from "ethers";

interface Deployed {
  address: string;
  abi: InterfaceAbi;
}

/** The contracts one network runs, as `export:sepolia` committed them. */
export interface ProtocolDeployment {
  chainId: number;
  name: string;
  explorerUrl: string | null;
  collection: Deployed & { deployBlock: number };
  pantry: Deployed | null;
  croq: Deployed | null;
  cCroq: Deployed | null;
  ramp: Deployed | null;
  market: { pair: string; usdc: string } | null;
  /** What one faucet call mints, on a test network. */
  usdcFaucet: bigint | null;
}

export function deploymentFor(network: string, overrides: { address?: string; startBlock?: number } = {}): ProtocolDeployment {
  if (network !== "sepolia") throw new Error(`no deployment for network "${network}"`);
  // A collection address override points at another deployment: its economy is not this one.
  const own = !overrides.address;
  return {
    chainId: SEPOLIA.chainId,
    name: SEPOLIA.name,
    explorerUrl: SEPOLIA.explorerUrl,
    collection: {
      address: overrides.address ?? SEPOLIA_DEPLOYMENT.address,
      abi: SEPOLIA_DEPLOYMENT.abi,
      deployBlock: overrides.startBlock ?? SEPOLIA_DEPLOYMENT.deployBlock,
    },
    pantry: own ? SEPOLIA_ECONOMY.pantry : null,
    croq: own ? SEPOLIA_ECONOMY.croq : null,
    cCroq: own ? SEPOLIA_ECONOMY.cCroq : null,
    ramp: own ? (SEPOLIA_DEPLOYMENT.ramp ?? null) : null,
    market: own && SEPOLIA_ECONOMY.market ? { pair: SEPOLIA_ECONOMY.market.pair, usdc: SEPOLIA_ECONOMY.market.usdc } : null,
    // Zama's USDCMock lets anyone mint: 100 test dollars a go.
    usdcFaucet: 100_000_000n,
  };
}
