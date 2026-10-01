import { spec, TRAIT_KEYS } from "@dno/game-spec";
import { buildBoxSpec } from "./boxSpec";
import { VICE_NAMES, type CatSpec } from "./catSpec";
import { stateDef, traitDef } from "./traits";

export interface MetadataAttribute {
  trait_type: string;
  value: string | number;
  display_type?: "number";
}

/** The ERC-721 metadata JSON marketplaces read. */
export interface TokenMetadata {
  name: string;
  description: string;
  image: string;
  attributes: MetadataAttribute[];
}

/** Facts about a sealed box that the chain already made public. None of them comes from the seed. */
export interface PublicBoxFacts {
  feeds?: number;
  duelsWon?: number;
  vetCertified?: boolean;
  entangledWith?: number | null;
}

function publicAttributes(facts: PublicBoxFacts): MetadataAttribute[] {
  const out: MetadataAttribute[] = [];
  if (facts.feeds) out.push({ trait_type: "Times fed", value: facts.feeds, display_type: "number" });
  if (facts.duelsWon) out.push({ trait_type: "Duels won", value: facts.duelsWon, display_type: "number" });
  if (facts.vetCertified) out.push({ trait_type: "Vet Certified", value: "Yes" });
  if (facts.entangledWith !== null && facts.entangledWith !== undefined) out.push({ trait_type: "Entangled with", value: buildBoxSpec(facts.entangledWith).serial });
  return out;
}

/** What the weigh-in made public. Nothing until the cat is weighed. */
function weightAttributes(cat: CatSpec): MetadataAttribute[] {
  if (!cat.weight) return [];
  const out: MetadataAttribute[] = [
    { trait_type: "Build", value: cat.weight.buildName },
    { trait_type: "Weight", value: cat.weight.weight, display_type: "number" },
  ];
  if (cat.weight.sick && cat.weight.diseaseName) out.push({ trait_type: "Disease", value: cat.weight.diseaseName });
  return out;
}

/**
 * Metadata of a sealed box. It is a function of the token id and of public chain facts
 * only: anything else would leak what the box is there to hide.
 */
export function sealedMetadata(tokenId: number, image: string, facts: PublicBoxFacts = {}): TokenMetadata {
  const box = buildBoxSpec(tokenId);
  return {
    name: `${spec.collection.name} ${box.serial}`,
    description: "A sealed box. There is a cat inside, and its traits are encrypted on-chain: nobody can read them, the holder included, until the box is opened. Opening is permanent.",
    image,
    attributes: [{ trait_type: "Status", value: "Sealed" }, ...publicAttributes(facts)],
  };
}

/** Metadata of an opened box: everything the reveal made public. */
export function revealedMetadata(tokenId: number, cat: CatSpec, image: string, facts: PublicBoxFacts = {}): TokenMetadata {
  const box = buildBoxSpec(tokenId);
  const accessory = cat.accessory.golden ? `Golden ${cat.traits.accessory.name.toLowerCase()}` : cat.traits.accessory.name;
  return {
    name: `${spec.collection.name} ${box.serial}`,
    description: `Opened. ${stateDef(cat.state).name} ${cat.traits.breed.name.toLowerCase()}, ${cat.traits.mood.name.toLowerCase()}, found in the ${cat.traits.room.name.toLowerCase()}. It broke the ${cat.traits.brokenThing.name.toLowerCase()}.`,
    image,
    attributes: [
      { trait_type: "Status", value: "Opened" },
      { trait_type: "State", value: stateDef(cat.state).name },
      ...TRAIT_KEYS.map((key) => ({ trait_type: traitDef(key).name, value: key === "accessory" ? accessory : cat.traits[key].name })),
      { trait_type: "Condition", value: VICE_NAMES[cat.vice] },
      { trait_type: "Rarity", value: cat.rarity.tierName },
      { trait_type: "Rarity score", value: cat.rarity.score, display_type: "number" as const },
      { trait_type: "Golden", value: cat.rarity.golden ? "Yes" : "No" },
      ...weightAttributes(cat),
      ...publicAttributes(facts),
    ],
  };
}
