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
  feedBound: number;
  paidShakeHolderBps: number;
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
    feedBound: spec.affection.perFeedMax + 1,
    paidShakeHolderBps: spec.mechanics.paidShake.holderShareBps,
    ...overrides,
  };
}

export interface PantryParams {
  welcomeBag: number;
  purrMaxPerDay: number;
  vetMultiplier: number;
  purrMaxDays: number;
  halvingPeriod: number;
  mealsPerDay: number;
  maxEatenPerDay: number;
  mealTreasuryBps: number;
  mealBurnBps: number;
  buildFloors: [number, number, number, number];
  sickMinWeight: number;
  sickWeightSpread: number;
  diseaseRollBelow: [number, number];
  maxBoxesPerClaim: number;
}

/** Most boxes one Pantry.claim may cover; keeps a claim well under the 20M HCU limit. */
export const MAX_BOXES_PER_CLAIM = 10;

/** The Pantry constructor argument, read from the economy section of the spec. */
export function pantryParamsFromSpec(overrides: Partial<PantryParams> = {}): PantryParams {
  const { spec } = loadSpec();
  const e = spec.economy;
  const builds: { key: string; minWeight: number }[] = e.weight.builds;
  const order = ["thin", "normal", "chubby", "fat", "huge"];
  if (builds.map((b) => b.key).join() !== order.join() || builds[0]!.minWeight !== 0) {
    throw new Error(`economy.weight.builds must be ${order.join(", ")}, from a minWeight of 0`);
  }
  const diseases: { rollBelow: number }[] = e.weight.diseases;
  if (diseases.length !== 3 || diseases[2]!.rollBelow !== 65_536) {
    throw new Error("economy.weight.diseases must list 3 diseases, the last one up to 65536");
  }
  return {
    welcomeBag: e.welcomeBag.amount,
    purrMaxPerDay: e.purr.maxPerDay,
    vetMultiplier: e.purr.vetMultiplier,
    purrMaxDays: e.purr.maxDays,
    halvingPeriod: e.purr.halvingDays * 86_400,
    mealsPerDay: e.meal.mealsPerDay,
    maxEatenPerDay: e.meal.maxEatenPerDay,
    mealTreasuryBps: e.meal.treasuryBps,
    mealBurnBps: e.meal.burnBps,
    buildFloors: builds.slice(1).map((b) => b.minWeight) as [number, number, number, number],
    sickMinWeight: e.weight.sick.minWeight,
    sickWeightSpread: e.weight.sick.weightSpread,
    diseaseRollBelow: [diseases[0]!.rollBelow, diseases[1]!.rollBelow],
    maxBoxesPerClaim: MAX_BOXES_PER_CLAIM,
    ...overrides,
  };
}

/** Token supply and how it is split, checked to add up. */
export function economyFromSpec() {
  const { spec } = loadSpec();
  const e = spec.economy;
  const allocation = Object.fromEntries(
    e.allocation.map((a: { key: string; amount: number }) => [a.key, BigInt(a.amount)]),
  ) as Record<"gameReserve" | "welcomeBags" | "liquidity" | "treasury", bigint>;
  const totalSupply = BigInt(e.token.totalSupply);
  const sum = Object.values(allocation).reduce((a, b) => a + b, 0n);
  if (sum !== totalSupply) throw new Error(`allocation adds up to ${sum}, total supply is ${totalSupply}`);
  if (allocation.welcomeBags !== BigInt(spec.collection.maxSupply) * BigInt(e.welcomeBag.amount)) {
    throw new Error("welcomeBags must equal maxSupply x welcomeBag");
  }
  return { totalSupply, allocation };
}
