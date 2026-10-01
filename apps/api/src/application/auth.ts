import { normalizeAddress, type Address } from "../domain/types";
import { loggedIn, type User } from "../domain/user";
import type { Store } from "./ports/store";

/** Recovers the address that signed a personal message (EIP-191). */
export interface SignatureVerifier {
  recover(message: string, signature: string): Address;
}

/** Stateless session tokens. */
export interface SessionSigner {
  issue(address: Address, expiresAt: number): string;
  /** The address, or null if the token is forged or expired at `now`. */
  verify(token: string, now: number): Address | null;
}

export interface Clock {
  /** Unix seconds. */
  now(): number;
}

export class Unauthorized extends Error {}

const NONCE_TTL = 10 * 60;
const SESSION_TTL = 30 * 24 * 60 * 60;

/**
 * Sign-in with a wallet: the backend hands out a one-time message, the wallet signs it, and the
 * signature proves the address. Nothing is sent on-chain and no gas is spent.
 */
export class SignIn {
  constructor(
    private readonly store: Store,
    private readonly verifier: SignatureVerifier,
    private readonly sessions: SessionSigner,
    private readonly clock: Clock,
    private readonly domain: string,
    private readonly randomNonce: () => string,
  ) {}

  /** The text a wallet signs: readable, bound to this site, this address and this nonce. */
  message(address: Address, nonce: string, expiresAt: number): string {
    return [
      `${this.domain} wants you to sign in with your account:`,
      address,
      "",
      "Sign in to DO NOT OPEN. This costs nothing and sends no transaction.",
      "",
      `Nonce: ${nonce}`,
      `Expiration Time: ${new Date(expiresAt * 1000).toISOString()}`,
    ].join("\n");
  }

  async challenge(rawAddress: string): Promise<{ message: string; expiresAt: number }> {
    const address = normalizeAddress(rawAddress);
    const nonce = this.randomNonce();
    const expiresAt = this.clock.now() + NONCE_TTL;
    await this.store.saveNonce(address, nonce, expiresAt);
    return { message: this.message(address, nonce, expiresAt), expiresAt };
  }

  async verify(rawAddress: string, signature: string): Promise<{ token: string; expiresAt: number; user: User }> {
    const address = normalizeAddress(rawAddress);
    // Taken, not read: one signature signs in once.
    const nonce = await this.store.takeNonce(address);
    const now = this.clock.now();
    if (!nonce || nonce.expiresAt < now) throw new Unauthorized("no sign-in pending for this address, or it expired");
    let signer: Address;
    try {
      signer = normalizeAddress(this.verifier.recover(this.message(address, nonce.nonce, nonce.expiresAt), signature));
    } catch {
      throw new Unauthorized("unreadable signature");
    }
    if (signer !== address) throw new Unauthorized("signed by another account");

    const user = loggedIn(await this.store.user(address), address, now);
    await this.store.saveUser(user);
    const expiresAt = now + SESSION_TTL;
    return { token: this.sessions.issue(address, expiresAt), expiresAt, user };
  }

  /** The address behind a bearer token. */
  whoIs(token: string): Address {
    const address = this.sessions.verify(token, this.clock.now());
    if (!address) throw new Unauthorized("invalid or expired session");
    return address;
  }
}
