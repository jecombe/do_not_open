import type { Adoption, Rat, RatKind } from "../../domain/rats";
import type { Address } from "../../domain/types";

/**
 * The rats' read model (rebuilt by a replay), and the adoptions of AI rats with their 3D models
 * (kept across replays: they are not on the chain). An AI rat's picture is on Arweave, like a
 * cat's; its model stays here, served by the API.
 */
export interface RatStore {
  rat(ratId: number): Promise<Rat | null>;
  /** The owner's rats, by id. */
  ratsOf(owner: Address): Promise<Rat[]>;
  /** The rat minted from this seed (decimal) or job (bytes32), if any. */
  ratOfRef(ref: string): Promise<Rat | null>;
  /** Paid shakes by each of these addresses. */
  sniffsOf(accounts: Address[]): Promise<Map<Address, number>>;
  /** Paid rats by kind: the whitelist's gifts are outside the caps. */
  ratCounts(): Promise<{ kind: RatKind; count: number }[]>;
  /** Rats this address minted, both kinds: each address mints at most the spec's maxPerWallet. */
  ratsMintedBy(minter: Address): Promise<number>;
  adoption(jobId: string): Promise<Adoption | null>;
  adoptionOfRef(jobRef: string): Promise<Adoption | null>;
  saveAdoption(a: Adoption): Promise<void>;
  /** An adopted AI rat's 3D model (GLB), by its job's bytes32. Saved once. */
  saveRatModel(jobRef: string, glb: Uint8Array, at: number): Promise<void>;
  ratModel(jobRef: string): Promise<Uint8Array | null>;
}

/** Brings a picture under a byte budget: an AI rat's sketch, to fit Arweave's free uploads. */
export interface ImageShrinker {
  shrink(jpeg: Uint8Array, maxBytes: number): Uint8Array;
}

/** Signs AI rat adoptions for the Rats contract, with the attester's key. */
export interface AdoptionSigner {
  readonly address: Address;
  /** The bytes32 a studio job is minted under: keccak256 of its id. */
  jobRef(jobId: string): string;
  /** The EIP-712 `Adopt(minter, job, uri, deadline)` the contract checks. */
  sign(minter: Address, jobRef: string, uri: string, deadline: number): Promise<string>;
}

/** A file one of the studio's services made, read back: only from its hosts, and capped in size. */
export interface ServiceFiles {
  get(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }>;
}
