import { BrowserProvider, type Eip1193Provider, type Signer } from "ethers";
import { ChainError } from "../types";

/** Where signatures come from: a browser wallet, or a fixed signer in scripts and tests. */
export interface WalletSource {
  current(): Signer | null;
  /** May prompt the user. */
  connect(): Promise<Signer>;
  disconnect(): Promise<void>;
  onChange(listener: (signer: Signer | null) => void): () => void;
}

/** A signer that is already there: a private key in Node, a test account. */
export class StaticWallet implements WalletSource {
  constructor(private readonly signer: Signer) {}
  current = () => this.signer;
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

/** An injected browser wallet (EIP-1193), kept on one chain. */
export class InjectedWallet implements WalletSource {
  private signer: Signer | null = null;
  private readonly listeners = new Set<(signer: Signer | null) => void>();

  constructor(
    private readonly ethereum: Eip1193 | undefined,
    private readonly chain: ChainParams,
  ) {
    if (!ethereum) return;
    ethereum.on?.("accountsChanged", ((accounts: string[]) => void this.adopt(accounts)) as never);
    // Wallets recommend a reload on chain change; dropping the signer is enough here,
    // the next action asks to switch back.
    ethereum.on?.("chainChanged", (() => void this.restore()) as never);
    void this.restore();
  }

  current(): Signer | null {
    return this.signer;
  }

  async connect(): Promise<Signer> {
    const ethereum = this.require();
    try {
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
      await this.ensureChain();
      const signer = await this.adopt(accounts);
      if (!signer) throw new ChainError("rejected", "The wallet did not share an account.");
      remember(true);
      return signer;
    } catch (error) {
      if (error instanceof ChainError) throw error;
      if ((error as { code?: number }).code === 4001) throw new ChainError("rejected", "The request was declined in the wallet.");
      throw new ChainError("unknown", (error as Error).message ?? "The wallet refused to connect.");
    }
  }

  async disconnect(): Promise<void> {
    // EIP-1193 has no disconnect: forget the account on this side.
    remember(false);
    this.set(null);
  }

  onChange(listener: (signer: Signer | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Picks the session back up without prompting, if the user connected before. */
  private async restore(): Promise<void> {
    if (!this.ethereum || !remembered()) return;
    try {
      const accounts = (await this.ethereum.request({ method: "eth_accounts" })) as string[];
      const chainId = Number(await this.ethereum.request({ method: "eth_chainId" }));
      await this.adopt(chainId === this.chain.chainId ? accounts : []);
    } catch {
      this.set(null);
    }
  }

  private async adopt(accounts: string[]): Promise<Signer | null> {
    const account = accounts[0];
    if (!account || !this.ethereum) {
      this.set(null);
      return null;
    }
    const signer = await new BrowserProvider(this.ethereum, this.chain.chainId).getSigner(account);
    this.set(signer);
    return signer;
  }

  private async ensureChain(): Promise<void> {
    const ethereum = this.require();
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

  private require(): Eip1193 {
    if (!this.ethereum) throw new ChainError("no-wallet", "No wallet found in this browser.");
    return this.ethereum;
  }

  private set(signer: Signer | null): void {
    this.signer = signer;
    for (const l of this.listeners) l(signer);
  }
}

function remembered(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(on: boolean): void {
  try {
    if (on) localStorage.setItem(REMEMBER_KEY, "1");
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // Private windows may refuse storage; the user just reconnects next time.
  }
}
