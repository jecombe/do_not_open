import { parseUnits } from "ethers";
import { packCostUsd, studio, type StudioSpec } from "@dno/game-spec";

export interface PackParam {
  price: bigint;
  sketches: number;
  models: number;
}

/**
 * The StudioPacks constructor's packs, from packages/game-spec/studio.json, in id order. Refuses
 * a spec whose ids are not 0, 1, 2... or whose pack would sell below `minMargin` times its cost.
 */
export function studioPacksFromSpec(spec: StudioSpec = studio): PackParam[] {
  const packs = [...spec.packs].sort((a, b) => a.id - b.id);
  packs.forEach((p, i) => {
    if (p.id !== i) throw new Error(`studio pack ids must be 0, 1, 2...: found ${p.id} at ${i}`);
    if (Number(p.priceUsdc) < spec.minMargin * packCostUsd(p, spec)) {
      throw new Error(`studio pack "${p.key}" sells for ${p.priceUsdc} USDC, under ${spec.minMargin}x its cost of ${packCostUsd(p, spec)}`);
    }
  });
  return packs.map((p) => ({ price: parseUnits(p.priceUsdc, 6), sketches: p.sketches, models: p.models }));
}
