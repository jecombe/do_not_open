import { parseUnits } from "ethers";
import { spec, type GameSpec } from "@dno/game-spec";

export interface MarketParams {
  feeBps: number;
  /** What the contract hardcodes: checked against it by the tests. */
  maxFeeBps: number;
  maxPrice: bigint;
}

/** The FleaMarket numbers, from packages/game-spec/spec.json. */
export function marketParamsFromSpec(s: GameSpec = spec): MarketParams {
  const m = s.market;
  if (!Number.isInteger(m.feeBps) || m.feeBps < 0 || m.feeBps > m.maxFeeBps) throw new Error(`market fee ${m.feeBps} bps is outside 0..${m.maxFeeBps}`);
  return { feeBps: m.feeBps, maxFeeBps: m.maxFeeBps, maxPrice: parseUnits(m.maxPriceUsdc, 6) };
}
