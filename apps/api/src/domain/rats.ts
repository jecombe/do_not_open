import type { Address } from "./types";

export type RatKind = "seed" | "model";

/**
 * A rat from the studio, adopted as an ERC-721. Unlike a box, everything about it is public: its
 * owner follows the Transfer events. A read model, folded from the Rats contract's logs.
 */
export interface Rat {
  id: number;
  kind: RatKind;
  /** The seed in decimal for a seed rat; the studio job's bytes32 (keccak256 of its id) for an AI rat. */
  ref: string;
  /** For an AI rat, the ar:// record of its files. */
  uri: string | null;
  owner: Address;
  minter: Address;
  mintedBlock: number;
  /** Unix seconds, when the index knew the block's time. */
  mintedAt: number | null;
  /** Handed out by the whitelist's gifts, free: outside the paid rats' caps and the wallet limit. */
  gift: boolean;
}

/**
 * An AI rat's picture and record once on Arweave (its model stays with the API): kept so a second
 * adoption signs again without uploading again.
 */
export interface Adoption {
  /** The studio job's id (a UUID). */
  jobId: string;
  /** Its bytes32 on-chain: keccak256 of the id. */
  jobRef: string;
  account: Address;
  prompt: string;
  imageId: string;
  recordId: string;
  createdAt: number;
}

/** The rat a transfer leaves behind: a new owner, or a fresh rat when the mint's transfer comes before its RatMinted. */
export function transferred(rat: Rat | null, e: { ratId: number; to: Address; block: number; timestamp: number | null }): Rat {
  if (rat) return { ...rat, owner: e.to };
  return { id: e.ratId, kind: "seed", ref: "", uri: null, owner: e.to, minter: e.to, mintedBlock: e.block, mintedAt: e.timestamp, gift: false };
}

/** What RatMinted says about a rat; its owner stays the one the transfers left. */
export function minted(rat: Rat | null, e: { ratId: number; minter: Address; kind: RatKind; ref: string; uri: string; paid: string; block: number; timestamp: number | null }): Rat {
  return {
    id: e.ratId,
    kind: e.kind,
    ref: e.ref,
    uri: e.uri || null,
    owner: rat?.owner ?? e.minter,
    minter: e.minter,
    mintedBlock: e.block,
    mintedAt: e.timestamp ?? rat?.mintedAt ?? null,
    // Every paid rat costs something: a free one is a gift.
    gift: BigInt(e.paid || "0") === 0n,
  };
}

/** The Arweave id in an ar:// URI, or null. */
export const arId = (uri: string | null): string | null => (uri?.startsWith("ar://") ? uri.slice(5) || null : null);
