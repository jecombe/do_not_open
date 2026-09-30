import { keccak256 } from "ethers";
import { readFileSync } from "node:fs";

/**
 * Builds the DoNotOpenConfig constructor argument from packages/game-spec/spec.json,
 * so the contract can never drift from the chain-agnostic source of truth.
 */
export const SPEC_PATH: string = require.resolve("@dno/game-spec/spec.json");

type Five<T> = [T, T, T, T, T];

function five<T>(values: T[]): Five<T> {
  if (values.length !== 5) throw new Error(`the contract expects 5 traits, the spec has ${values.length}`);
  return values as Five<T>;
}

export interface ConfigParams {
  specHash: string;
  maxSupply: number;
  maxPerTx: number;
  stateRollBelow: [number, number, number];
  stateScoreBonus: [number, number, number, number];
  traitOffset: Five<number>;
  traitWeight: Five<number>;
  variantWidths: Five<string>;
  goldenThreshold: number;
  goldenScoreBonus: number;
}

export function loadSpec() {
  const raw = readFileSync(SPEC_PATH);
  return { spec: JSON.parse(raw.toString("utf8")), specHash: keccak256(raw) };
}

export function configParamsFromSpec(overrides: Partial<ConfigParams> = {}): ConfigParams {
  const { spec, specHash } = loadSpec();
  const traits = [...spec.traits].sort((a: { index: number }, b: { index: number }) => a.index - b.index);
  const offsetOf = (field: string): number => {
    const slice = spec.seed.layout.find((l: { field: string }) => l.field === field);
    if (!slice) throw new Error(`seed layout has no field "${field}"`);
    return slice.offset;
  };
  const states = [...spec.states].sort((a: { id: number }, b: { id: number }) => a.id - b.id);

  return {
    specHash,
    maxSupply: spec.collection.maxSupply,
    maxPerTx: spec.mechanics.mint.maxPerTx,
    stateRollBelow: [states[0].rollBelow, states[1].rollBelow, states[2].rollBelow],
    stateScoreBonus: [states[0].scoreBonus, states[1].scoreBonus, states[2].scoreBonus, states[3].scoreBonus],
    traitOffset: five<number>(traits.map((t: { key: string }) => offsetOf(t.key))),
    traitWeight: five<number>(traits.map((t: { weight: number }) => t.weight)),
    // One byte per variant. A width of 256 cannot occur: every trait has several variants.
    variantWidths: five<string>(
      traits.map(
        (t: { variants: { width: number }[] }) =>
          "0x" + t.variants.map((v) => v.width.toString(16).padStart(2, "0")).join(""),
      ),
    ),
    goldenThreshold: spec.affection.goldenThreshold,
    goldenScoreBonus: spec.affection.goldenScoreBonus,
    ...overrides,
  };
}
