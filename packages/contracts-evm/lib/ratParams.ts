import { parseUnits } from "ethers";
import { studio, type StudioSpec } from "@dno/game-spec";

export interface RatParams {
  seedPrice: bigint;
  modelPrice: bigint;
  maxSeedRats: number;
  maxModelRats: number;
  maxPerWallet: number;
  /** Free rats the whitelist's gifts may hand out, outside the caps above. */
  maxGiftRats: number;
  perDay: number;
  maxDays: number;
  /** CROQ the RatPantry is funded with at deployment. */
  fund: bigint;
  /** A 16-bit draw below [0] is power 1, below [1] power 2, else power 3. */
  powerBelow: [number, number];
  /** Part of a sniff's price a power-1 rat gets back, in basis points. */
  sniffRebateBps: number;
  trickSeconds: number;
  rechargeSeconds: number;
}

/** The spec's odds (basis points, summing to 10,000) as bounds on a uniform 16-bit draw. */
export function powerBounds(odds: readonly number[]): [number, number] {
  if (odds.length !== 3 || odds.some((o) => !Number.isInteger(o) || o <= 0) || odds[0]! + odds[1]! + odds[2]! !== 10_000) throw new Error("rat power odds must be three positive basis points summing to 10,000");
  const bound = (bps: number) => Math.round((bps * 65_536) / 10_000);
  return [bound(odds[0]!), bound(odds[0]! + odds[1]!)];
}

/** The Rats and RatPantry numbers, from packages/game-spec/studio.json. */
export function ratParamsFromSpec(spec: StudioSpec = studio): RatParams {
  const r = spec.rats;
  const seedPrice = parseUnits(r.mint.seedPriceUsdc, 6);
  const modelPrice = parseUnits(r.mint.modelPriceUsdc, 6);
  if (seedPrice <= 0n || modelPrice <= 0n) throw new Error("rat prices must be positive: a free rat could be farmed for croquettes");
  const { maxSeedRats, maxModelRats, maxPerWallet } = r.mint;
  if (![maxSeedRats, maxModelRats, maxPerWallet].every((n) => Number.isInteger(n) && n > 0)) throw new Error("rat caps must be positive integers: an unlimited mint would empty the pantry");
  if (r.powers.sniffRebateBps < 0 || r.powers.sniffRebateBps > 10_000 || r.powers.trickDays <= 0 || r.powers.rechargeDays < 0) throw new Error("rat tricks: rebate within 0..10,000 bps, a positive duration");
  return {
    seedPrice, modelPrice, maxSeedRats, maxModelRats, maxPerWallet, maxGiftRats: r.mint.maxGiftRats ?? 0, perDay: r.croquettes.perDay, maxDays: r.croquettes.maxDays, fund: BigInt(r.croquettes.fund),
    powerBelow: powerBounds(r.powers.odds),
    sniffRebateBps: r.powers.sniffRebateBps,
    trickSeconds: r.powers.trickDays * 86_400,
    rechargeSeconds: r.powers.rechargeDays * 86_400,
  };
}
