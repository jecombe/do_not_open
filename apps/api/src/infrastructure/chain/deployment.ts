import { SEPOLIA, SEPOLIA_DEPLOYMENT, SEPOLIA_ECONOMY, type Deployment } from "@dno/chain-adapter/deployments";
import type { V3Market } from "@dno/chain-adapter/node";
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
  /**
   * Where the index starts: the earliest of the protocol's contracts. The credits contract can be
   * older than the collection when only the collection was redeployed, and its purchases count.
   */
  indexFrom: number;
  pantry: Deployed | null;
  croq: Deployed | null;
  cCroq: Deployed | null;
  ramp: Deployed | null;
  /** Decryption credits, bought in USDC. Null where none was deployed. */
  credits: Deployed | null;
  /** The studio's packs, bought in USDC before any AI generation. Null where none was deployed. */
  studio: Deployed | null;
  /** The depot's rats (ERC-721) and the pantry that pays them CROQ. Null where none was deployed. */
  rats: (Deployed & { deployBlock?: number | null }) | null;
  ratPantry: (Deployed & { deployBlock?: number | null }) | null;
  /** The rats' tricks: sniffs, shields and jams. Null where none was deployed. */
  ratTricks: (Deployed & { deployBlock?: number | null }) | null;
  /** The flea market, where players sell to each other in cUSDC: wallets' permits name it. Null where none was deployed. */
  fleaMarket: Deployed | null;
  /** The sealed vault: its relayer sends holders' requests, and wallets' permits name it. Null where none was deployed. */
  vault: Deployed | null;
  /** Zama's contracts on this network, as the Relayer SDK's preset names them. */
  fhevm: FhevmConfig;
  /** The Uniswap V3 CROQ/USDC pool and the locked position CROQ is sold from. */
  market: V3Market | null;
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

type Optional = (Deployed & { deployBlock?: number | null }) | null | undefined;
/** `dno:export` writes the studio, the rats, their pantry and the flea market next to the credits once they are deployed. */
const EXTRA = SEPOLIA_DEPLOYMENT as Deployment & { studio?: Optional; rats?: Optional; ratPantry?: Optional; ratTricks?: Optional };
const SEPOLIA_STUDIO = EXTRA.studio ?? null;
const SEPOLIA_RATS = EXTRA.rats ?? null;
const SEPOLIA_RAT_PANTRY = EXTRA.ratPantry ?? null;
const SEPOLIA_RAT_TRICKS = EXTRA.ratTricks ?? null;
const SEPOLIA_FLEA_MARKET = EXTRA.market ?? null;

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
    indexFrom: Math.min(
      overrides.startBlock ?? SEPOLIA_DEPLOYMENT.deployBlock,
      (own && SEPOLIA_DEPLOYMENT.credits?.deployBlock) || Number.MAX_SAFE_INTEGER,
      (own && SEPOLIA_STUDIO?.deployBlock) || Number.MAX_SAFE_INTEGER,
      (own && SEPOLIA_RATS?.deployBlock) || Number.MAX_SAFE_INTEGER,
      (own && SEPOLIA_RAT_PANTRY?.deployBlock) || Number.MAX_SAFE_INTEGER,
      (own && SEPOLIA_RAT_TRICKS?.deployBlock) || Number.MAX_SAFE_INTEGER,
    ),
    pantry: own ? SEPOLIA_ECONOMY.pantry : null,
    croq: own ? SEPOLIA_ECONOMY.croq : null,
    cCroq: own ? SEPOLIA_ECONOMY.cCroq : null,
    ramp: own ? (SEPOLIA_DEPLOYMENT.ramp ?? null) : null,
    credits: own ? (SEPOLIA_DEPLOYMENT.credits ?? null) : null,
    studio: own ? SEPOLIA_STUDIO : null,
    rats: own ? SEPOLIA_RATS : null,
    ratPantry: own ? SEPOLIA_RAT_PANTRY : null,
    ratTricks: own ? SEPOLIA_RAT_TRICKS : null,
    fleaMarket: own ? SEPOLIA_FLEA_MARKET : null,
    vault: own ? (SEPOLIA_DEPLOYMENT.vault ?? null) : null,
    fhevm: SEPOLIA_FHEVM,
    market: own ? SEPOLIA_ECONOMY.market : null,
    // Zama's USDCMock lets anyone mint: 100 test dollars a go.
    usdcFaucet: 100_000_000n,
  };
}
