import { parseUnits } from "ethers";

/**
 * The price of one decryption credit, in USDC's smallest unit (6 decimals).
 *
 * Zama prices its relayer in US dollars and only takes $ZAMA as the means of payment, at the
 * oracle's rate of the day; credits are sold in USDC. So the price follows Zama's dollar price
 * for one decryption, times a margin, and never the token's market price: a credit keeps
 * covering what it stands for when $ZAMA moves. A credit is one unit: one decrypted value, and
 * an encrypted input costs RELAYER_INPUT_UNITS of them (5: Zama charges an input five times a
 * decryption, at every plan).
 *
 * `zamaUsd` is the collection's dollar price for one decryption on its Zama plan (0.001 to 0.1
 * on the price list); the margin covers the free daily allowance and the public decryptions
 * nobody is charged for.
 */
export function creditPrice(zamaUsd: string, margin: string): bigint {
  const usd = parseUnits(zamaUsd, 18);
  const m = parseUnits(margin, 18);
  if (usd <= 0n || m < 10n ** 18n) throw new Error("the Zama price must be positive and the margin at least 1");
  // 36 decimals down to USDC's 6, rounded up to a whole micro-dollar: never below cost.
  const scale = 10n ** 30n;
  return (usd * m + scale - 1n) / scale;
}

/** CREDIT_PRICE_USDC as given, or the price derived from ZAMA_DECRYPT_USD and CREDIT_MARGIN (2 by default). */
export function creditPriceFromEnv(env: NodeJS.ProcessEnv = process.env): bigint {
  if (env.CREDIT_PRICE_USDC) return parseUnits(env.CREDIT_PRICE_USDC, 6);
  if (env.ZAMA_DECRYPT_USD) return creditPrice(env.ZAMA_DECRYPT_USD, env.CREDIT_MARGIN || "2");
  return parseUnits("0.01", 6);
}
