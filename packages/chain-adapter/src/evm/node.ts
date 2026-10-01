import { JsonRpcProvider, Wallet, type Signer } from "ethers";
import { SEPOLIA, SEPOLIA_DEPLOYMENT, SEPOLIA_ECONOMY } from "./chains";
import { EvmFhevmAdapter } from "./EvmFhevmAdapter";
import { StaticWallet } from "./wallet";

export { EvmFhevmAdapter } from "./EvmFhevmAdapter";
export { SEPOLIA, SEPOLIA_DEPLOYMENT, SEPOLIA_ECONOMY } from "./chains";
export * from "../types";

export interface NodeEvmOptions {
  rpcUrl?: string;
  address?: string;
  /** Private key of the acting account. Read it from the environment, never from source. */
  privateKey?: string;
  /** Or any ethers signer. It is reconnected to the adapter's provider. */
  signer?: Signer;
}

/** Sepolia from Node (scripts, metadata rendering, smoke tests). Read-only without a key. */
export function createSepoliaNodeAdapter(opts: NodeEvmOptions = {}): EvmFhevmAdapter {
  const chain = { ...SEPOLIA, rpcUrl: opts.rpcUrl || SEPOLIA.rpcUrl };
  const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  const signer = opts.signer?.connect(provider) ?? (opts.privateKey ? new Wallet(opts.privateKey, provider) : null);

  return new EvmFhevmAdapter({
    chain,
    address: opts.address || SEPOLIA_DEPLOYMENT.address,
    abi: SEPOLIA_DEPLOYMENT.abi,
    // An address override points at another collection: its economy, if any, is not this one.
    economy: opts.address ? undefined : SEPOLIA_ECONOMY,
    readProvider: provider,
    wallet: signer
      ? new StaticWallet(signer)
      : { current: () => null, options: () => [], connect: () => Promise.reject(new Error("no signer configured")), disconnect: async () => undefined, onChange: () => () => undefined },
    loadRelayer: async () => {
      const { createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/node");
      return createInstance({ ...SepoliaConfig, network: chain.rpcUrl });
    },
  });
}
