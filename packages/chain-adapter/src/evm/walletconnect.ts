import type { Eip1193Provider } from "ethers";
import type { ChainParams } from "./wallet";

/** The parts of WalletConnect's EthereumProvider the wallet source relies on. */
export interface WalletConnectProvider extends Eip1193Provider {
  /** Opens the WalletConnect modal unless a session is already there, and resolves to its accounts. */
  enable(): Promise<string[]>;
  disconnect(): Promise<void>;
  session?: unknown;
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

/** One per page: WalletConnect's core refuses a second init, which React's dev double-mount would cause. */
let loading: Promise<WalletConnectProvider> | null = null;

/**
 * WalletConnect, for phones and any browser without a wallet extension: the modal lists
 * wallet apps on mobile and shows a QR code on desktop. Loaded on first use only.
 */
export function loadWalletConnect(projectId: string, chain: ChainParams): Promise<WalletConnectProvider> {
  loading ??= init(projectId, chain).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

async function init(projectId: string, chain: ChainParams): Promise<WalletConnectProvider> {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const origin = window.location.origin;
  const provider = await EthereumProvider.init({
    projectId,
    // Optional rather than required: a wallet that does not list Sepolia up front can still connect and switch.
    optionalChains: [chain.chainId],
    rpcMap: { [chain.chainId]: chain.rpcUrl },
    showQrModal: true,
    metadata: {
      name: "DO NOT OPEN",
      description: "Sealed boxes on an encrypted chain.",
      url: origin,
      icons: [`${origin}/favicon.svg`],
    },
  });
  return provider as unknown as WalletConnectProvider;
}
