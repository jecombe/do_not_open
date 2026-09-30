import { spec } from "@dno/game-spec";

/**
 * The contract reports a shaken or duelled trait as its bit offset inside the seed.
 * The app wants the trait's index in `spec.traits`.
 */
export function traitIndexAtOffset(offset: number): number {
  const slice = spec.seed.layout.find((l) => l.offset === offset);
  const trait = spec.traits.find((t) => t.key === slice?.field);
  if (!trait) throw new Error(`no trait at seed offset ${offset}`);
  return trait.index;
}
