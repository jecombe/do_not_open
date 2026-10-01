import type { Eip1193Provider, Signer } from "ethers";
import { ChainError, type WalletOption } from "../types";
import type { ChainParams, WalletSource } from "./wallet";

/** What the app's sign-in layer lends to the wallet source. */
export interface SignIn {
  /** Opens the sign-in prompt. The outcome comes back through `use` or `fail`. */
  login(): void;
  logout(): Promise<void>;
}

/**
 * A wallet the app signs in by its own means (Privy: e-mail, social, or any wallet) and
 * hands over as an EIP-1193 provider. Only types are imported here, so building one costs
 * nothing in mock mode.
 */
export class ExternalWallet implements WalletSource {
  /** The chain the adapter runs on, set when the adapter is built. */
  chain: ChainParams | null = null;
  private signer: Signer | null = null;
  private signIn: SignIn | null = null;
  private waiting: { resolve(signer: Signer): void; reject(error: Error): void }[] = [];
  private readonly listeners = new Set<(signer: Signer | null) => void>();

  current(): Signer | null {
    return this.signer;
  }

  /** The sign-in prompt has its own list of ways in. */
  options(): WalletOption[] {
    return [];
  }

  connect(): Promise<Signer> {
    if (this.signer) return Promise.resolve(this.signer);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      // Asked before the sign-in layer loaded: `bind` opens the prompt.
      this.signIn?.login();
    });
  }

  async disconnect(): Promise<void> {
    await this.signIn?.logout();
    this.set(null);
  }

  onChange(listener: (signer: Signer | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bind(signIn: SignIn): void {
    this.signIn = signIn;
    if (this.waiting.length) signIn.login();
  }

  /** The account the user signed in with, or null once they signed out. */
  async use(ethereum: Eip1193Provider | null, account?: string): Promise<void> {
    if (!ethereum) {
      if (this.signer) this.set(null);
      return;
    }
    const { BrowserProvider } = await import("ethers");
    this.set(await new BrowserProvider(ethereum, this.chain?.chainId).getSigner(account));
  }

  /** The sign-in was closed or went wrong: whoever is waiting on `connect` hears about it. */
  fail(error: ChainError): void {
    for (const w of this.waiting.splice(0)) w.reject(error);
  }

  private set(signer: Signer | null): void {
    this.signer = signer;
    if (signer) for (const w of this.waiting.splice(0)) w.resolve(signer);
    for (const l of this.listeners) l(signer);
  }
}
