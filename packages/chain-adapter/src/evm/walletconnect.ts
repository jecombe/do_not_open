import type { Eip1193Provider } from "ethers";
import type { ChainParams } from "./wallet";

/** The parts of WalletConnect's EthereumProvider the wallet source relies on. */
export interface WalletConnectProvider extends Eip1193Provider {
  /** Opens the WalletConnect modal unless a session is already there, and resolves to its accounts. */
  enable(): Promise<string[]>;
  disconnect(): Promise<void>;
  session?: { namespaces: Record<string, { accounts: string[] }> };
  on(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

/** Offered next to the app's chain: mobile wallets such as MetaMask may stall on a session that names a testnet only. */
const MAINNET = 1;

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
    // Optional rather than required, so no wallet is turned away. The app's chain comes first and is
    // the provider's default; when the wallet approves it, switching to it needs no round trip.
    optionalChains: [chain.chainId, MAINNET],
    rpcMap: { [chain.chainId]: chain.rpcUrl },
    showQrModal: true,
    metadata: {
      name: "DO NOT OPEN",
      description: "Sealed boxes on an encrypted chain.",
      url: origin,
      icons: [`${origin}/favicon.svg`],
      // Where the wallet app sends the user back once a request is answered.
      redirect: { universal: window.location.href },
    },
  });
  return provider as unknown as WalletConnectProvider;
}

/** Whether the session lets the dapp use `chainId` without asking the wallet. */
export function approvesChain(provider: WalletConnectProvider, chainId: number): boolean {
  return !!provider.session?.namespaces.eip155?.accounts.some((a) => a.startsWith(`eip155:${chainId}:`));
}
