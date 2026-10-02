import { normalizeAddress, type Address } from "../domain/types";
import { Unauthorized, type Clock, type SignatureVerifier } from "./auth";
import { BadRequest } from "./queries";
import type { Store } from "./ports/store";

/** A wallet's signature under one version of the terms: kept as it was signed, as evidence. */
export interface TermsAcceptance {
  address: Address;
  version: string;
  /** SHA-256 of the full English text of that version, lowercase hex. */
  hash: string;
  /** The exact message the wallet signed (EIP-191). */
  message: string;
  signature: string;
  /** Unix seconds, by this server's clock. */
  receivedAt: number;
}

/** What the signed message must say, line by line: who, which version, which text. */
const ADDRESS_LINE = /^I, (0x[0-9a-fA-F]{40}), have read and accept the terms of DO NOT OPEN, version ([\w.-]{1,32}),/m;
const HASH_LINE = /^([0-9a-f]{64})$/m;
const MAX_MESSAGE = 4_000;

/**
 * The release form a player signs before playing. The app shows the terms, the wallet signs a
 * message naming the address, the version and the SHA-256 of the full text, and the signature is
 * filed here. Nothing on-chain, no gas; the backend learns that an address accepted, nothing more.
 */
export class AcceptTerms {
  constructor(
    private readonly store: Store,
    private readonly verifier: SignatureVerifier,
    private readonly clock: Clock,
  ) {}

  async accept(rawAddress: string, message: string, signature: string): Promise<TermsAcceptance> {
    const address = normalizeAddress(rawAddress);
    if (message.length > MAX_MESSAGE) throw new BadRequest("message too long");
    const named = ADDRESS_LINE.exec(message);
    const hash = HASH_LINE.exec(message)?.[1];
    if (!named || !hash) throw new BadRequest("not a DO NOT OPEN release form");
    if (normalizeAddress(named[1]!) !== address) throw new BadRequest("the form names another address");
    let signer: Address;
    try {
      signer = normalizeAddress(this.verifier.recover(message, signature));
    } catch {
      throw new Unauthorized("unreadable signature");
    }
    if (signer !== address) throw new Unauthorized("signed by another account");
    const acceptance: TermsAcceptance = { address, version: named[2]!, hash, message, signature, receivedAt: this.clock.now() };
    // The first signature of a version is the one kept: signing again changes nothing.
    return (await this.store.saveTermsAcceptance(acceptance)) ?? acceptance;
  }

  of(rawAddress: string): Promise<TermsAcceptance[]> {
    return this.store.termsAcceptances(normalizeAddress(rawAddress));
  }
}
