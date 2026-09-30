import { spec } from "@dno/game-spec";
import { buildCatSpec, resolveTrait, type CatSpec } from "@dno/generator";
import { ChainError, formatAmount, sameAddress, shortAddress, type Address, type CollectionInfo, type RevealedContents, type Step, type TraitRoll } from "@dno/chain-adapter";

/** What the contract refused, in the depot's words. */
const REFUSALS: Record<string, string> = {
  NotHolder: "Only the holder of this box can do that.",
  NotSealed: "This box is already open.",
  NotObserving: "This box is not waiting to be opened.",
  HolderShakesForFree: "You hold this box. Shake it for free instead.",
  AliveCheckAlreadyRequested: "This box has already been checked. One check per box.",
  AliveCheckNotPending: "There is no alive check waiting on this box.",
  WrongPayment: "The fee changed. Reload the page and try again.",
  SoldOut: "Every box has been shipped.",
  InvalidQuantity: "That is more boxes than one order can carry.",
  NothingToClaim: "Nothing to claim yet.",
  SameBox: "Pick two different boxes.",
  AlreadyEntangled: "One of these boxes is already entangled. It is permanent.",
  NoSuchProposal: "That proposal is gone: the box changed hands.",
  WrongDuelStatus: "This duel has already moved on. Reload to see where it stands.",
  ChallengerNoLongerHolds: "The challenger no longer holds their box. The duel is void.",
  ERC721NonexistentToken: "That box has not been minted.",
};

export function errorCopy(error: unknown): string {
  if (!(error instanceof ChainError)) return error instanceof Error ? error.message : "Something went wrong.";
  switch (error.code) {
    case "rejected":
      return "Declined in the wallet. Nothing happened.";
    case "insufficient-funds":
      return "This wallet does not have enough ETH for that.";
    case "no-wallet":
      return "No wallet found in this browser. Install one, such as MetaMask or Rabby, and reload.";
    case "not-connected":
      return "Connect a wallet first.";
    case "decryption":
      return "The decryption service did not answer. Nothing is lost: try again in a moment.";
    case "reverted":
      return (error.reason && REFUSALS[error.reason]) || error.message;
    default:
      return error.message;
  }
}

/** One line for whatever the user is waiting on. `secret` decryptions are for their eyes only. */
export function stepCopy(step: Step | null, secret = false): string {
  switch (step) {
    case "wallet":
      return "Confirm it in your wallet.";
    case "confirming":
      return "Sent. Waiting for the chain to include it.";
    case "decrypting":
      return secret ? "Decrypting, for you only. This takes a few seconds." : "Decrypting. The result will be public.";
    case "proving":
      return "Decrypted. Confirm once more to write the proof on-chain.";
    default:
      return "Getting ready…";
  }
}

/** "Mood" and "Grumpy" for a roll. */
export function traitCopy(t: TraitRoll): { trait: string; variant: string } {
  const def = spec.traits[t.traitIndex]!;
  return { trait: def.name, variant: resolveTrait(def.key, t.roll).name };
}

/** Rebuilds the cat from what the chain revealed, and checks the two agree. */
export function catFromRevealed(r: RevealedContents): CatSpec {
  const cat = buildCatSpec({ seed: r.seed, affection: r.affection });
  if (cat.rarity.score !== r.score || cat.rarity.golden !== r.golden) {
    console.warn("[chain] the generator and the chain disagree about this cat", { chain: r, generator: cat.rarity });
  }
  return cat;
}

export const holderCopy = (owner: Address, account: Address | null) => (sameAddress(owner, account) ? "You" : shortAddress(owner));

export const fee = (amount: bigint, c: CollectionInfo | null) => (c ? `${formatAmount(amount, c.currency.decimals)} ${c.currency.symbol}` : "");
