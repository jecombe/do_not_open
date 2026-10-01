import { buildCatSpec, type CatSpec } from "@dno/generator";
import { ChainError, formatAmount, type CollectionInfo, type Payment, type RevealedContents, type Step, type TraitRoll, type WeighIn } from "@dno/chain-adapter";
import { lookup, t } from "../i18n/app";
import { rollNames } from "../i18n/names";

export function errorCopy(error: unknown): string {
  if (!(error instanceof ChainError)) return error instanceof Error ? error.message : t("error.generic");
  switch (error.code) {
    case "rejected":
      return t("error.rejected");
    case "insufficient-funds":
      return t("error.funds");
    case "insufficient-usdc":
      return t("error.usdc");
    case "unpaid":
      return t("error.unpaid");
    case "not-yours":
      return t("error.notYours");
    case "no-wallet":
      return t("error.noWallet");
    case "not-connected":
      return t("error.notConnected");
    case "decryption":
      return t("error.decryption");
    case "reverted":
      // What the contract refused, in the depot's words.
      return (error.reason && lookup(`refusal.${error.reason}`)) || error.message;
    default:
      return error.message;
  }
}

/** One line for whatever the user is waiting on. `secret` decryptions are for their eyes only. */
export function stepCopy(step: Step | null, secret = false): string {
  switch (step) {
    case "encrypting":
      return t("step.encrypting");
    case "wallet":
      return t("step.wallet");
    case "confirming":
      return t("step.confirming");
    case "decrypting":
      return secret ? t("step.decryptingSecret") : t("step.decryptingPublic");
    case "proving":
      return t("step.proving");
    default:
      return t("step.ready");
  }
}

/** "Mood" and "Grumpy" for a roll. */
export const traitCopy = (r: TraitRoll): { trait: string; variant: string } => rollNames(r.traitIndex, r.roll);

/** Rebuilds the cat from what the chain revealed, and checks the two agree. The weigh-in, once
 *  there is one, shapes the cat and adds to its score; the box contract never sees it. */
export function catFromRevealed(r: RevealedContents, weighIn?: WeighIn | null): CatSpec {
  const cat = buildCatSpec({ seed: r.seed, affection: r.affection });
  if (cat.rarity.score !== r.score || cat.rarity.golden !== r.golden) {
    console.warn("[chain] the generator and the chain disagree about this cat", { chain: r, generator: cat.rarity });
  }
  return weighIn ? buildCatSpec({ seed: r.seed, affection: r.affection, weighIn }) : cat;
}

/** Who holds a box, as far as this page may say: the account itself, or nobody knows. */
export const holderCopy = (mine: boolean) => (mine ? t("holder.you") : t("holder.hidden"));

/** How many boxes are sold, as far as the milestones say. */
export function saleCopy(c: CollectionInfo): string {
  const { milestones, reached, soldOut } = c.sale;
  if (soldOut) return t("sale.soldOut", { max: c.maxSupply });
  if (reached === 0) return t("sale.fewerThan", { n: milestones[0] ?? c.maxSupply });
  return t("sale.moreThan", { n: milestones[reached - 1]! });
}

/** A price, in the stablecoin it will be paid in. */
export const fee = (amount: bigint, c: CollectionInfo | null, pay: Payment = "cusdc") =>
  c ? `${formatAmount(amount, c.payment.decimals)} ${pay === "cusdc" ? c.payment.confidentialSymbol : c.payment.symbol}` : "";
