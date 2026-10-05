import raw from "./studio.json";

export type StudioUnit = "sketch" | "model";

export interface StudioPackDef {
  /** The pack's id in the StudioPacks contract. */
  id: number;
  key: string;
  name: string;
  /** Decimal USDC, e.g. "2". */
  priceUsdc: string;
  sketches: number;
  models: number;
}

export interface StudioSpec {
  version: number;
  name: string;
  rule: string;
  units: Record<StudioUnit, { name: string; estimatedCostUsd: string; rule: string }>;
  packs: StudioPackDef[];
  minMargin: number;
  marginRule: string;
  prompt: { minLength: number; maxLength: number; style: string; rule: string };
  events: Record<string, { fields: string[]; note: string }>;
  rats: {
    name: string;
    rule: string;
    mint: { seedPriceUsdc: string; modelPriceUsdc: string; maxPriceUsdc: string; maxSeedRats: number; maxModelRats: number; maxPerWallet: number; rule: string };
    croquettes: { perDay: number; maxDays: number; fund: number; rule: string };
    events: Record<string, { fields: string[]; note: string }>;
  };
}

/**
 * The studio's numbers: the packs sold in USDC and what one unit is expected to cost. Kept out
 * of spec.json on purpose: the deployed DoNotOpenConfig stores spec.json's hash, and the studio
 * is sold beside the collection, not by it.
 */
export const studio = raw as StudioSpec;

/** What a pack's units are expected to cost the collection, in dollars. */
export function packCostUsd(pack: StudioPackDef, spec: StudioSpec = studio): number {
  return pack.sketches * Number(spec.units.sketch.estimatedCostUsd) + pack.models * Number(spec.units.model.estimatedCostUsd);
}

/** The player's words inside the house style. */
export function styledPrompt(prompt: string, spec: StudioSpec = studio): string {
  return spec.prompt.style.replace("{prompt}", prompt.trim());
}
