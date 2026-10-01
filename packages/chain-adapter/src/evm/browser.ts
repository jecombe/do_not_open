import { JsonRpcProvider } from "ethers";
import { SEPOLIA, SEPOLIA_DEPLOYMENT } from "./chains";
import { EvmFhevmAdapter } from "./EvmFhevmAdapter";
import type { ExternalWallet } from "./external";
import { InjectedWallet } from "./wallet";

export interface BrowserEvmOptions {
  /** Read endpoint. Must allow cross-origin requests. Defaults to a public one. */
  rpcUrl?: string;
  /** Overrides the committed deployment address. */
  address?: string;
  /** Signs with this wallet instead of the browser's injected ones. */
  wallet?: ExternalWallet;
}

/** Sepolia through the injected wallet (or the one the app signs in) and the Relayer SDK's browser build. */
export function createSepoliaBrowserAdapter(opts: BrowserEvmOptions = {}): EvmFhevmAdapter {
  const chain = { ...SEPOLIA, rpcUrl: opts.rpcUrl || SEPOLIA.rpcUrl };
  if (opts.wallet) opts.wallet.chain = chain;
  const ethereum = (globalThis as { ethereum?: ConstructorParameters<typeof InjectedWallet>[0] }).ethereum;

  return new EvmFhevmAdapter({
    chain,
    address: opts.address || SEPOLIA_DEPLOYMENT.address,
    abi: SEPOLIA_DEPLOYMENT.abi,
    readProvider: new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true }),
    wallet: opts.wallet ?? new InjectedWallet(ethereum, chain),
    loadRelayer: async () => {
      // Several megabytes of WASM: loaded on the first decryption, never before.
      const { initSDK, createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/web");
      await initSDK();
      return createInstance({ ...SepoliaConfig, network: chain.rpcUrl });
    },
  });
}
