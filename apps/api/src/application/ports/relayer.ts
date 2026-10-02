import type { Address } from "../../domain/types";

/** What Zama's relayer answered, passed on to the browser as it is. */
export interface UpstreamReply {
  status: number;
  body: unknown;
  /** The relayer's Retry-After header: the SDK polls on it. */
  retryAfter: string | null;
}

/** Zama's relayer, reached with the collection's API key. */
export interface RelayerUpstream {
  post(path: string, body: unknown): Promise<UpstreamReply>;
  get(path: string): Promise<UpstreamReply>;
}

/** The EIP-712 message a wallet signs to have values re-encrypted for its session key. */
export interface UserDecryptPermit {
  publicKey: string;
  contractAddresses: string[];
  startTimestamp: string;
  durationDays: string;
  extraData: string;
  signature: string;
}

export interface PermitVerifier {
  /** The address that signed the permit. Throws when the signature cannot be read. */
  signer(permit: UserDecryptPermit): Address;
}

/** Asks the chain itself, for handles published too recently for the index to have them. */
export interface PublicationCheck {
  recentlyPublished(handles: string[]): Promise<string[]>;
}
