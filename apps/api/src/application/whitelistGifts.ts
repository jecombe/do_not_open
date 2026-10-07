import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { normalizeAddress, type Address } from "../domain/types";
import type { AllowListEntry } from "./allowList";

/** What `StandardMerkleTree.dump()` writes: kept as the frozen list, and loaded back to serve proofs. */
export type GiftTreeDump = ReturnType<StandardMerkleTree<[string, number]>["dump"]>;

/** What a wallet sends `WhitelistGifts.claim`. */
export interface GiftProof {
  tier: number;
  proof: string[];
  root: string;
}

/**
 * The whitelist frozen into a Merkle tree of (wallet, tier), OpenZeppelin's standard leaves, the
 * ones `WhitelistGifts` checks. Only the seated claimants within the tiers are in it.
 */
export function giftTree(entries: readonly AllowListEntry[]): StandardMerkleTree<[string, number]> | null {
  const leaves = entries.filter((e) => e.tier !== null).map((e): [string, number] => [e.address, e.tier!]);
  // A tree needs a leaf: nobody seated yet, nothing to freeze.
  return leaves.length ? StandardMerkleTree.of(leaves, ["address", "uint8"]) : null;
}

/** Serves each wallet its proof from the frozen tree; nothing before the list is frozen. */
export class GiftProofs {
  private readonly proofs = new Map<Address, { tier: number; proof: string[] }>();
  readonly root: string | null;

  constructor(dump: GiftTreeDump | null) {
    if (!dump) {
      this.root = null;
      return;
    }
    const tree = StandardMerkleTree.load(dump);
    tree.validate();
    this.root = tree.root;
    for (const [i, [address, tier]] of tree.entries()) this.proofs.set(normalizeAddress(address), { tier: Number(tier), proof: tree.getProof(i) });
  }

  get frozen(): boolean {
    return this.root !== null;
  }

  get count(): number {
    return this.proofs.size;
  }

  proofOf(address: string): GiftProof | null {
    const p = this.proofs.get(normalizeAddress(address));
    return p && this.root ? { ...p, root: this.root } : null;
  }
}
