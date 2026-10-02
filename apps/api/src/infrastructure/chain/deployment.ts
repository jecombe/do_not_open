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
  /** Decryption credits, bought in USDC. Null where none was deployed. */
  credits: Deployed | null;
  /** Zama's contracts on this network, as the Relayer SDK's preset names them. */
  fhevm: FhevmConfig;
  market: { pair: string; usdc: string } | null;
  /** What one faucet call mints, on a test network. */
  usdcFaucet: bigint | null;
}

export interface FhevmConfig {
  /** The ACL: it logs every handle a contract makes publicly decryptable. */
  acl: string;
  /** The contract user-decryption permits are signed for (EIP-712 domain, with the host chain's id). */
  verifyingContractDecryption: string;
  /** Zama's relayer, versioned. */
  relayerUrl: string;
}

/** From `SepoliaConfig` in @zama-fhe/relayer-sdk 0.4.1. */
const SEPOLIA_FHEVM: FhevmConfig = {
  acl: "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
  verifyingContractDecryption: "0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478",
  relayerUrl: "https://relayer.testnet.zama.org/v2",
};

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
    credits: own ? (SEPOLIA_DEPLOYMENT.credits ?? null) : null,
    fhevm: SEPOLIA_FHEVM,
    market: own && SEPOLIA_ECONOMY.market ? { pair: SEPOLIA_ECONOMY.market.pair, usdc: SEPOLIA_ECONOMY.market.usdc } : null,
    // Zama's USDCMock lets anyone mint: 100 test dollars a go.
    usdcFaucet: 100_000_000n,
  };
}
