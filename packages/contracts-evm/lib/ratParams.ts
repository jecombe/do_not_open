import { parseUnits } from "ethers";
import { studio, type StudioSpec } from "@dno/game-spec";

export interface RatParams {
  seedPrice: bigint;
  modelPrice: bigint;
  maxSeedRats: number;
  maxModelRats: number;
  maxPerWallet: number;
  perDay: number;
  maxDays: number;
  /** CROQ the RatPantry is funded with at deployment. */
  fund: bigint;
}

/** The Rats and RatPantry numbers, from packages/game-spec/studio.json. */
export function ratParamsFromSpec(spec: StudioSpec = studio): RatParams {
  const r = spec.rats;
  const seedPrice = parseUnits(r.mint.seedPriceUsdc, 6);
  const modelPrice = parseUnits(r.mint.modelPriceUsdc, 6);
  if (seedPrice <= 0n || modelPrice <= 0n) throw new Error("rat prices must be positive: a free rat could be farmed for croquettes");
  const { maxSeedRats, maxModelRats, maxPerWallet } = r.mint;
  if (![maxSeedRats, maxModelRats, maxPerWallet].every((n) => Number.isInteger(n) && n > 0)) throw new Error("rat caps must be positive integers: an unlimited mint would empty the pantry");
  return { seedPrice, modelPrice, maxSeedRats, maxModelRats, maxPerWallet, perDay: r.croquettes.perDay, maxDays: r.croquettes.maxDays, fund: BigInt(r.croquettes.fund) };
}
