import type { Adoption, Rat, RatKind } from "../../domain/rats";
import type { Address } from "../../domain/types";

/**
 * The rats' read model (rebuilt by a replay) and the adoptions of AI rats (kept across replays:
 * their files are on Arweave for good).
 */
export interface RatStore {
  rat(ratId: number): Promise<Rat | null>;
  /** The owner's rats, by id. */
  ratsOf(owner: Address): Promise<Rat[]>;
  /** The rat minted from this seed (decimal) or job (bytes32), if any. */
  ratOfRef(ref: string): Promise<Rat | null>;
  /** Paid shakes by each of these addresses. */
  sniffsOf(accounts: Address[]): Promise<Map<Address, number>>;
  ratCounts(): Promise<{ kind: RatKind; count: number }[]>;
  adoption(jobId: string): Promise<Adoption | null>;
  adoptionOfRef(jobRef: string): Promise<Adoption | null>;
  saveAdoption(a: Adoption): Promise<void>;
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
