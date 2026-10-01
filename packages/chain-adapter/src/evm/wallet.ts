import { BrowserProvider, type Eip1193Provider, type Signer } from "ethers";
import { ChainError, type WalletOption } from "../types";
import { approvesChain, loadWalletConnect, type WalletConnectProvider } from "./walletconnect";

/** Where signatures come from: a browser wallet, or a fixed signer in scripts and tests. */
export interface WalletSource {
  current(): Signer | null;
  /** The wallets the user can pick from. Empty when there is nothing to pick. */
  options(): WalletOption[];
  /** May prompt the user. `id` picks one of `options()`; without it, the last one used or the only one. */
  connect(id?: string): Promise<Signer>;
  disconnect(): Promise<void>;
  onChange(listener: (signer: Signer | null) => void): () => void;
}

/** A signer that is already there: a private key in Node, a test account. */
export class StaticWallet implements WalletSource {
  constructor(private readonly signer: Signer) {}
  current = () => this.signer;
  options = () => [];
  connect = async () => this.signer;
  disconnect = async () => undefined;
  onChange = () => () => undefined;
}

export interface ChainParams {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  currency: { name: string; symbol: string; decimals: number };
}

type Eip1193 = Eip1193Provider & {
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
};

const REMEMBER_KEY = "dno:wallet-connected";
/** Stands for `window.ethereum` when no wallet announces itself through EIP-6963. */
const LEGACY_ID = "injected";
const WALLETCONNECT_ID = "walletconnect";

interface Announced {
  info: { rdns: string; name: string; icon?: string };
  provider: Eip1193;
}

/**
 * Browser wallets, kept on one chain. Every extension that implements EIP-6963 announces
 * itself, so the user can pick one even when another has taken `window.ethereum`. With a
 * WalletConnect project id, wallet apps on another device or on the phone are offered too.
 */
export class InjectedWallet implements WalletSource {
  private signer: Signer | null = null;
  private active: { id: string; ethereum: Eip1193 } | null = null;
  private readonly found = new Map<string, Announced>();
  private readonly listeners = new Set<(signer: Signer | null) => void>();
  /** Loaded on first use: the WalletConnect SDK and its modal weigh more than the rest of the wallet code. */
  private walletConnect: Promise<WalletConnectProvider> | null = null;
  private walletConnectProvider: WalletConnectProvider | undefined;

  private readonly onAccounts = ((accounts: string[]) => void this.adopt(accounts)) as never;
  // Wallets recommend a reload on chain change; dropping the signer is enough here,
  // the next connect asks to switch back.
  private readonly onChain = (() => void this.restore()) as never;

  constructor(
    private readonly legacy: Eip1193 | undefined,
    private readonly chain: ChainParams,
    private readonly walletConnectProjectId?: string,
  ) {
    if (typeof window === "undefined") return;
    window.addEventListener("eip6963:announceProvider", ((event: CustomEvent<Announced>) => {
      const { info, provider } = event.detail;
      if (this.found.has(info.rdns)) return;
      this.found.set(info.rdns, { info, provider });
      // The wallet used last time may announce after start-up: pick the session back up then.
      if (!this.active && remembered() === info.rdns) void this.restore();
    }) as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    void this.restore();
    // No extension, as on a phone: WalletConnect is the only way in, so its modal should open without a wait.
    if (walletConnectProjectId && !legacy) void this.loadWalletConnect().catch(() => undefined);
  }

  current(): Signer | null {
    return this.signer;
  }

  options(): WalletOption[] {
    const announced = [...this.found.values()].map(({ info }) => ({ id: info.rdns, name: info.name, icon: info.icon ?? null }));
    const injected = announced.length || !this.legacy ? announced : [{ id: LEGACY_ID, name: "Browser wallet", icon: null }];
    return this.walletConnectProjectId ? [...injected, { id: WALLETCONNECT_ID, name: "WalletConnect", icon: null }] : injected;
  }

  async connect(id?: string): Promise<Signer> {
    try {
      const wanted = id ?? this.options()[0]?.id;
      const walletConnect = wanted === WALLETCONNECT_ID ? await this.loadWalletConnect() : null;
      const ethereum = this.use(wanted);
      // WalletConnect answers eth_requestAccounts from its session: `enable` is what opens the modal.
      const accounts = walletConnect ? await walletConnect.enable() : ((await ethereum.request({ method: "eth_requestAccounts" })) as string[]);
      await this.ensureChain(ethereum);
      const signer = await this.adopt(accounts);
      if (!signer) throw new ChainError("rejected", "The wallet did not share an account.");
      remember(this.active!.id);
      return signer;
    } catch (error) {
      if (error instanceof ChainError) throw error;
      // 4001 from extensions, 5000 from WalletConnect wallets; closing the WalletConnect modal resets the request.
      const { code, message } = error as { code?: number; message?: string };
      if (code === 4001 || code === 5000 || message?.includes("Connection request reset")) {
        throw new ChainError("rejected", "The request was declined in the wallet.");
      }
      throw new ChainError("unknown", (error as Error).message ?? "The wallet refused to connect.");
    }
  }

  async disconnect(): Promise<void> {
    // EIP-1193 has no disconnect: forget the account on this side. A WalletConnect session is ended for real.
    if (this.active?.id === WALLETCONNECT_ID) await (await this.loadWalletConnect()).disconnect().catch(() => undefined);
    remember(null);
    this.set(null);
  }

  onChange(listener: (signer: Signer | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Makes `id` the wallet in use, moving the event listeners over to it. */
  private use(id: string | undefined): Eip1193 {
    const ethereum = id === LEGACY_ID ? this.legacy : id === WALLETCONNECT_ID ? this.walletConnectProvider : id ? this.found.get(id)?.provider : undefined;
    if (!id || !ethereum) throw new ChainError("no-wallet", "No wallet found in this browser.");
    if (this.active?.ethereum !== ethereum) {
      this.active?.ethereum.removeListener?.("accountsChanged", this.onAccounts);
      this.active?.ethereum.removeListener?.("chainChanged", this.onChain);
      ethereum.on?.("accountsChanged", this.onAccounts);
      ethereum.on?.("chainChanged", this.onChain);
    }
    this.active = { id, ethereum };
    return ethereum;
  }

  /** Picks the session back up without prompting, if the user connected before. */
  private async restore(): Promise<void> {
    const id = remembered();
    if (!id) return;
    // Sessions saved before the picker existed only say "connected".
    const known = id === "1" ? this.options()[0]?.id : id;
    if (known === WALLETCONNECT_ID && this.walletConnectProjectId) {
      // The session lives in WalletConnect's own storage: the provider has to load to find it.
      const walletConnect = await this.loadWalletConnect().catch(() => null);
      if (!walletConnect?.session) return;
      // The session may come back on another of its chains; moving to an approved one prompts nobody.
      if (approvesChain(walletConnect, this.chain.chainId)) await this.ensureChain(walletConnect).catch(() => undefined);
    } else if (!known || !(known === LEGACY_ID ? this.legacy : this.found.has(known))) return;
    try {
      const ethereum = this.use(known);
      const accounts = (await ethereum.request({ method: "eth_accounts" })) as string[];
      const chainId = Number(await ethereum.request({ method: "eth_chainId" }));
      await this.adopt(chainId === this.chain.chainId ? accounts : []);
    } catch {
      this.set(null);
    }
  }

  private async adopt(accounts: string[]): Promise<Signer | null> {
    const account = accounts[0];
    if (!account || !this.active) {
      this.set(null);
      return null;
    }
    const signer = await new BrowserProvider(this.active.ethereum, this.chain.chainId).getSigner(account);
    this.set(signer);
    return signer;
  }

  private async ensureChain(ethereum: Eip1193): Promise<void> {
    const hex = "0x" + this.chain.chainId.toString(16);
    if (Number(await ethereum.request({ method: "eth_chainId" })) === this.chain.chainId) return;
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (error) {
      // 4902: the wallet does not know this chain yet.
      if ((error as { code?: number }).code !== 4902) {
        throw new ChainError("wrong-network", `Switch your wallet to ${this.chain.name} to continue.`);
      }
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: this.chain.name,
            rpcUrls: [this.chain.rpcUrl],
            nativeCurrency: this.chain.currency,
            blockExplorerUrls: this.chain.explorerUrl ? [this.chain.explorerUrl] : [],
          },
        ],
      });
    }
  }

  private loadWalletConnect(): Promise<WalletConnectProvider> {
    if (!this.walletConnectProjectId) return Promise.reject(new ChainError("no-wallet", "WalletConnect is not set up."));
    this.walletConnect ??= loadWalletConnect(this.walletConnectProjectId, this.chain).then(
      (provider) => {
        this.walletConnectProvider = provider;
        // The wallet app ended the session: the account goes with it.
        provider.on("disconnect", (() => {
          if (this.active?.id !== WALLETCONNECT_ID) return;
          remember(null);
          this.set(null);
        }) as never);
        return provider;
      },
      (error) => {
        this.walletConnect = null;
        throw error;
      },
    );
    return this.walletConnect;
  }

  private set(signer: Signer | null): void {
    this.signer = signer;
    for (const l of this.listeners) l(signer);
  }
}

/** Id of the wallet the user connected with last, if they did not disconnect since. */
function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(REMEMBER_KEY, id);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // Private windows may refuse storage; the user just reconnects next time.
  }
}
