import { JsonRpcProvider } from "ethers";
import { SEPOLIA, SEPOLIA_DEPLOYMENT, SEPOLIA_ECONOMY } from "./chains";
import { LocalStorageDecryptCache } from "./decryptCache";
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
  /** Reown (WalletConnect) project id. Without it, only wallets injected in the browser are offered. */
  walletConnectProjectId?: string;
  /**
   * Encrypt and decrypt through the API's relayer proxy (`apiUrl` + /relayer/v2) instead of
   * Zama's relayer. Required where the collection pays the relayer: the proxy holds the key and
   * counts each wallet's decryptions.
   */
  relayerProxy?: boolean;
}

/** Sepolia through an injected wallet or WalletConnect, and the Relayer SDK's browser build. */
export function createSepoliaBrowserAdapter(opts: BrowserEvmOptions = {}): EvmFhevmAdapter {
  const chain = { ...SEPOLIA, rpcUrl: opts.rpcUrl || SEPOLIA.rpcUrl };
  // The API indexes the committed deployment only: another address reads the chain.
  const indexer = opts.apiUrl && !opts.address ? new IndexerClient(opts.apiUrl) : null;
  const proxy = indexer && opts.relayerProxy ? `${opts.apiUrl!.replace(/\/$/, "")}/relayer/v2` : null;
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
    indexer: indexer ?? undefined,
    metered: !!proxy,
    credits: opts.address ? undefined : (SEPOLIA_DEPLOYMENT.credits ?? undefined),
    // Decrypted receipts, balances and shakes, kept per collection so a new deployment starts clean.
    decryptCache: new LocalStorageDecryptCache(`dno:decrypted:${(opts.address || SEPOLIA_DEPLOYMENT.address).toLowerCase()}`),
    readProvider: new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true }),
    wallet: new InjectedWallet(ethereum, chain, opts.walletConnectProjectId || undefined),
    loadRelayer: async () => {
      // Several megabytes of WASM: loaded on the first decryption, never before.
      const { initSDK, createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/web");
      await initSDK();
      // Not a Zama URL: the SDK speaks its v2 protocol to it as it is.
      return createInstance({ ...SepoliaConfig, network: chain.rpcUrl, ...(proxy ? { relayerUrl: proxy } : {}) });
    },
  });
}
