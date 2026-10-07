import { studio } from "@dno/game-spec";
import { buildCatSpec, type CatSpec } from "@dno/generator";
import { ChainError, formatAmount, type CollectionInfo, type Payment, type RevealedContents, type Step, type TraitRoll, type WeighIn } from "@dno/chain-adapter";
import { lookup, t, type AppKey } from "../i18n/app";
import { rollNames } from "../i18n/names";

/** What went wrong with an action, and what to try. */
export interface Problem {
  /** One sentence: what happened. */
  text: string;
  /** What to try, the likeliest first. */
  hints: string[];
  /** The transaction that failed, in a block explorer. */
  txUrl: string | null;
  /** Where to get what was missing: the wallet slip (decryption credits), the bureau de change
   *  (USDC, cUSDC), or a faucet for the gas coin. */
  fix: "wallet" | "exchange" | "gas" | null;
  /** With `fix: "exchange"`, the token the bureau should offer. */
  wanted?: "usdc" | "cusdc" | "credits";
}

/** What an action says, instead of the generic line, when it stopped half-way. */
export interface ProblemContext {
  collection?: CollectionInfo | null;
  /** The first transaction went through and running the action again would not pick it up:
   *  where to finish it instead. */
  resume?: AppKey;
  /** The transaction went through and only reading it back failed. */
  landed?: AppKey;
}

/** Free gas coin for the test networks, by chain name. */
const GAS_FAUCETS: Record<string, string> = {
  Sepolia: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
};
export const gasFaucet = (c: CollectionInfo | null | undefined): string | null => (c ? (GAS_FAUCETS[c.chain] ?? null) : null);

/** "0.00213" rather than eighteen decimals: three significant digits are enough to act on. */
const rough = (amount: bigint, decimals: number) => {
  const n = Number(formatAmount(amount, decimals));
  return n === 0 ? "0" : n.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
};

/** The error, worded for the user, with what to try next. */
export function problemOf(error: unknown, ctx: ProblemContext = {}): Problem {
  const c = ctx.collection ?? null;
  const p: Problem = { text: t("error.generic"), hints: [], txUrl: null, fix: null };
  if (!(error instanceof ChainError)) {
    p.text = error instanceof Error && error.message ? error.message : t("error.generic");
    p.hints.push(t("problem.unknownHint"));
    return p;
  }
  const { held, needed, txUrl, resumable, landed, mined } = error.detail;
  p.txUrl = txUrl ?? null;
  const coin = c?.currency.symbol ?? "ETH";
  const usdc = (v: bigint) => (c ? formatAmount(v, c.payment.decimals) : v.toString());

  switch (error.code) {
    case "rejected":
      p.text = t("error.rejected");
      break;
    case "wallet-busy":
      p.text = t("problem.walletBusy");
      p.hints.push(t("problem.walletBusyHint"));
      break;
    case "wrong-network":
      p.text = t("problem.wrongNetwork");
      p.hints.push(t("problem.wrongNetworkHint", { chain: c?.chain ?? "Sepolia" }));
      break;
    case "insufficient-funds":
      p.text = t("error.funds", { coin });
      if (held !== undefined && needed !== undefined && c) {
        p.hints.push(t("problem.fundsHave", { held: rough(held, c.currency.decimals), needed: rough(needed, c.currency.decimals), coin }));
      }
      p.hints.push(t("problem.fundsHint", { coin, symbol: c?.payment.symbol ?? "USDC" }));
      p.fix = gasFaucet(c) ? "gas" : null;
      break;
    case "insufficient-usdc":
      p.text = t("error.usdc");
      if (held !== undefined && needed !== undefined && c) p.hints.push(t("problem.usdcHave", { held: usdc(held), needed: usdc(needed), symbol: c.payment.symbol }));
      p.hints.push(t("problem.usdcHint"));
      p.fix = "exchange";
      p.wanted = "usdc";
      break;
    case "unpaid":
      p.text = t("error.unpaid");
      if (held !== undefined && needed !== undefined && c) {
        p.hints.push(t("problem.unpaidHave", { held: usdc(held), needed: usdc(needed), cSymbol: c.payment.confidentialSymbol }));
      } else {
        // Seen only after the fact: the price was not covered, or every box went.
        p.hints.push(t("problem.unpaidAfter"));
      }
      p.hints.push(t("problem.unpaidHint", { symbol: c?.payment.symbol ?? "USDC", cSymbol: c?.payment.confidentialSymbol ?? "cUSDC" }));
      p.fix = "exchange";
      p.wanted = "cusdc";
      break;
    case "missed":
      p.text = t("error.missed");
      p.hints.push(t("problem.missedHint"));
      break;
    case "not-yours":
      p.text = t("error.notYours");
      p.hints.push(t("problem.notYoursHint"));
      break;
    case "scrambled":
      p.text = t("error.scrambled");
      p.hints.push(t("problem.scrambledHint", { days: studio.rats.powers.trickDays }));
      break;
    case "no-wallet":
      p.text = t("error.noWallet");
      break;
    case "not-connected":
      p.text = t("error.notConnected");
      break;
    case "decryption":
      p.text = t("error.decryption");
      p.hints.push(t("problem.decryptionHint"));
      break;
    case "network":
      p.text = t("problem.network");
      p.hints.push(t("problem.networkHint"));
      break;
    case "no-credits":
      p.text = t("problem.noCredits");
      if (held !== undefined && needed !== undefined) p.hints.push(t("problem.noCreditsHave", { held: held.toString(), needed: needed.toString() }));
      p.hints.push(t("problem.noCreditsHint"));
      p.fix = "exchange";
      p.wanted = "credits";
      break;
    case "nonce":
      p.text = t("problem.nonce");
      p.hints.push(t("problem.nonceHint"), t("problem.nonceReset"));
      break;
    case "reverted": {
      // What the contract refused, in the depot's words.
      const named = error.reason ? lookup(`refusal.${error.reason}`) : null;
      p.text = named || (mined ? t("problem.revertedMined") : t("problem.revertedSilent"));
      const hint = error.reason ? lookup(`refusalHint.${error.reason}`) : t("problem.revertedHint");
      if (hint) p.hints.push(hint);
      break;
    }
    default:
      p.text = error.message || t("error.generic");
      p.hints.push(t("problem.unknownHint"));
  }

  // Half-way: the first transaction is on the chain, whatever failed after it.
  if (resumable) p.hints.unshift(t(ctx.resume ?? "problem.resume"));
  else if (landed) p.hints.unshift(t(ctx.landed ?? "problem.landed"));
  else if (p.txUrl && error.code === "network") p.hints.push(t("problem.networkSent"));
  return p;
}

/** The sentence and the likeliest way out, where there is no room for the rest. */
export function errorCopy(error: unknown): string {
  const { text, hints } = problemOf(error);
  return hints[0] ? `${text} ${hints[0]}` : text;
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
