import { JsonRpcProvider } from "ethers";
import { SEPOLIA, SEPOLIA_DEPLOYMENT, SEPOLIA_ECONOMY } from "./chains";
import { EvmFhevmAdapter } from "./EvmFhevmAdapter";
import { IndexerClient } from "./indexer";
import { InjectedWallet } from "./wallet";

export interface BrowserEvmOptions {
  /** Read endpoint. Must allow cross-origin requests. Defaults to a public one. */
  rpcUrl?: string;
  /** Overrides the committed deployment address. */
  address?: string;
  /** The DO NOT OPEN API, which indexes the committed deployment. Reads go to the RPC without it. */
  apiUrl?: string;
}

/** Sepolia through the injected wallet and the Relayer SDK's browser build. */
export function createSepoliaBrowserAdapter(opts: BrowserEvmOptions = {}): EvmFhevmAdapter {
  const chain = { ...SEPOLIA, rpcUrl: opts.rpcUrl || SEPOLIA.rpcUrl };
  const ethereum = (globalThis as { ethereum?: ConstructorParameters<typeof InjectedWallet>[0] }).ethereum;

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
    // The API indexes the committed deployment only: another address reads the chain.
    indexer: opts.apiUrl && !opts.address ? new IndexerClient(opts.apiUrl) : undefined,
    readProvider: new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true }),
    wallet: new InjectedWallet(ethereum, chain),
    loadRelayer: async () => {
      // Several megabytes of WASM: loaded on the first decryption, never before.
      const { initSDK, createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/web");
      await initSDK();
      return createInstance({ ...SepoliaConfig, network: chain.rpcUrl });
    },
  });
}
