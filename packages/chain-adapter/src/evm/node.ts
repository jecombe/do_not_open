import { JsonRpcProvider, Wallet, type Signer } from "ethers";
import { SEPOLIA, SEPOLIA_DEPLOYMENT, SEPOLIA_ECONOMY } from "./chains";
import { EvmFhevmAdapter } from "./EvmFhevmAdapter";
import { IndexerClient } from "./indexer";
import { StaticWallet } from "./wallet";

export { EvmFhevmAdapter } from "./EvmFhevmAdapter";
export type { EconomyDeployment, V3Market } from "./EvmFhevmAdapter";
export { SEPOLIA, SEPOLIA_DEPLOYMENT, SEPOLIA_ECONOMY } from "./chains";
export * from "../types";

export interface NodeEvmOptions {
  rpcUrl?: string;
  address?: string;
  /** Private key of the acting account. Read it from the environment, never from source. */
  privateKey?: string;
  /** Or any ethers signer. It is reconnected to the adapter's provider. */
  signer?: Signer;
  /** The DO NOT OPEN API: reads go there first. */
  apiUrl?: string;
  /** Encrypt and decrypt through the API's relayer proxy instead of Zama's relayer. Needs `apiUrl`. */
  relayerProxy?: boolean;
}

/** Sepolia from Node (scripts, metadata rendering, smoke tests). Read-only without a key. */
export function createSepoliaNodeAdapter(opts: NodeEvmOptions = {}): EvmFhevmAdapter {
  const chain = { ...SEPOLIA, rpcUrl: opts.rpcUrl || SEPOLIA.rpcUrl };
  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  const signer = opts.signer?.connect(provider) ?? (opts.privateKey ? new Wallet(opts.privateKey, provider) : null);
  const indexer = opts.apiUrl && !opts.address ? new IndexerClient(opts.apiUrl, { collection: SEPOLIA_DEPLOYMENT.address }) : null;
  const proxy = indexer && opts.relayerProxy ? `${opts.apiUrl!.replace(/\/$/, "")}/relayer/v2` : null;

  return new EvmFhevmAdapter({
    chain,
    address: opts.address || SEPOLIA_DEPLOYMENT.address,
    abi: SEPOLIA_DEPLOYMENT.abi,
    // An address override points at another collection: its economy, if any, is not this one.
    economy: opts.address ? undefined : SEPOLIA_ECONOMY,
    // Zama's USDCMock lets anyone mint: 100 test dollars a go.
    usdcFaucet: 100_000_000n,
    ramp: opts.address ? undefined : (SEPOLIA_DEPLOYMENT.ramp ?? undefined),
    // Events are read from here on: the collection's own receipts, milestones and openings.
    deployBlock: opts.address ? undefined : SEPOLIA_DEPLOYMENT.deployBlock,
    indexer: indexer ?? undefined,
    metered: !!proxy,
    credits: opts.address ? undefined : (SEPOLIA_DEPLOYMENT.credits ?? undefined),
    studio: opts.address ? undefined : (SEPOLIA_DEPLOYMENT.studio ?? undefined),
    readProvider: provider,
    wallet: signer
      ? new StaticWallet(signer)
      : { current: () => null, options: () => [], connect: () => Promise.reject(new Error("no signer configured")), disconnect: async () => undefined, onChange: () => () => undefined },
    loadRelayer: async () => {
      const { createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/node");
      return createInstance({ ...SepoliaConfig, network: chain.rpcUrl, ...(proxy && (await indexer!.matches()) ? { relayerUrl: proxy } : {}) });
    },
  });
}
