import { describe, expect, it } from "vitest";
import { spec, TRAIT_KEYS } from "@dno/game-spec";
import {
  BUILD_GIRTH,
  buildBoxSpec,
  buildCatSpec,
  buildForWeight,
  decodeSeed,
  encodeSeed,
  estimateScore,
  FIXTURE_SEEDS,
  minScoreForTopPercent,
  mulberry32,
  rarityScore,
  resolveTrait,
  revealedMetadata,
  scoreDistribution,
  stateFromRoll,
  tierForScore,
} from "../src";

describe("game spec integrity", () => {
  it("seed layout tiles all 64 bits without overlap", () => {
    let next = 0;
    for (const s of spec.seed.layout) {
      expect(s.offset).toBe(next);
      next += s.bits;
    }
    expect(next).toBe(spec.seed.bits);
  });

  it("every trait table covers exactly 256 rolls", () => {
    for (const t of spec.traits) {
      expect(t.variants.reduce((n, v) => n + v.width, 0), t.key).toBe(256);
    }
  });

  it("variants are ordered common to rare", () => {
    for (const t of spec.traits) {
      const widths = t.variants.map((v) => v.width);
      expect(widths, t.key).toEqual([...widths].sort((a, b) => b - a));
    }
  });

  it("state thresholds give 70 / 20 / 8 / 2 percent", () => {
    const target = [0.7, 0.2, 0.08, 0.02];
    let lower = 0;
    spec.states.forEach((s, i) => {
      expect((s.rollBelow - lower) / 65536).toBeCloseTo(target[i]!, 4);
      lower = s.rollBelow;
    });
    expect(lower).toBe(65536);
  });

  it("maxScore matches the formula", () => {
    const max = spec.traits.reduce((n, t) => n + t.weight * 255, 0) + Math.max(...spec.states.map((s) => s.scoreBonus));
    expect(spec.rarity.maxScore).toBe(max);
  });

  it("tier thresholds match the exact score distribution", () => {
    for (const tier of spec.rarity.tiers.slice(1)) {
      expect(tier.minScore, tier.key).toBe(minScoreForTopPercent(tier.topPercent));
    }
  });

  it("score distribution sums to the whole seed space", () => {
    const { counts, total } = scoreDistribution();
    expect(counts.reduce((a, b) => a + b, 0n)).toBe(total);
  });
});

describe("seed decoding", () => {
  it("round-trips", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const parts = {
        stateRoll: Math.floor(rand() * 65536),
        rolls: Object.fromEntries(TRAIT_KEYS.map((k) => [k, Math.floor(rand() * 256)])) as ReturnType<typeof decodeSeed>["rolls"],
        cosmetic: Math.floor(rand() * 256),
      };
      expect(decodeSeed(encodeSeed(parts))).toEqual(parts);
    }
  });

  it("rejects seeds wider than 64 bits", () => {
    expect(() => decodeSeed(1n << 64n)).toThrow(RangeError);
    expect(() => decodeSeed(-1n)).toThrow(RangeError);
  });

  it("resolves boundaries of the variant table", () => {
    expect(resolveTrait("breed", 0).variant).toBe("tabby");
    expect(resolveTrait("breed", 55).variant).toBe("tabby");
    expect(resolveTrait("breed", 56).variant).toBe("tuxedo");
    expect(resolveTrait("breed", 253).variant).toBe("loaf");
    expect(resolveTrait("breed", 254).variant).toBe("glitch");
    expect(resolveTrait("breed", 255).variant).toBe("glitch");
  });

  it("resolves state boundaries", () => {
    expect(stateFromRoll(0).key).toBe("alive");
    expect(stateFromRoll(45874).key).toBe("alive");
    expect(stateFromRoll(45875).key).toBe("asleep");
    expect(stateFromRoll(58982).key).toBe("ghost");
    expect(stateFromRoll(64225).key).toBe("quantum");
    expect(stateFromRoll(65535).key).toBe("quantum");
  });
});

describe("rarity", () => {
  it("computes the weighted sum", () => {
    const rolls = { breed: 10, mood: 20, accessory: 30, brokenThing: 40, room: 50 };
    expect(rarityScore(rolls, 400)).toBe(3 * 10 + 20 + 2 * 30 + 40 + 50 + 400);
  });

  it("maps scores to tiers", () => {
    expect(tierForScore(0).key).toBe("common");
    expect(tierForScore(1077).key).toBe("common");
    expect(tierForScore(1078).key).toBe("uncommon");
    expect(tierForScore(spec.rarity.maxScore).key).toBe("legendary");
  });

  it("estimates a box nobody felt like the whole collection", () => {
    const est = estimateScore([null, null, null, null, null]);
    expect(est.min).toBe(0);
    expect(est.max).toBe(spec.rarity.maxScore);
    const { counts, total } = scoreDistribution();
    for (const [i, tier] of spec.rarity.tiers.entries()) {
      const next = spec.rarity.tiers[i + 1]?.minScore ?? counts.length;
      const exact = counts.slice(tier.minScore, next).reduce((a, b) => a + b, 0n);
      expect(est.tiers[i]!.chance).toBeCloseTo(Number((exact * 1_000_000n) / total) / 1_000_000, 5);
    }
  });

  it("leaves only the state to chance once every trait is felt", () => {
    const rolls = [200, 10, 150, 90, 255];
    const base = rolls.reduce((sum, r, i) => sum + spec.traits[i]!.weight * r, 0);
    const est = estimateScore(rolls);
    expect(est.min).toBe(base);
    expect(est.max).toBe(base + 1000);
    expect(est.tiers.reduce((sum, t) => sum + t.chance, 0)).toBeCloseTo(1, 9);
    expect(est.tiers.find((t) => t.key === tierForScore(base).key)!.chance).toBeGreaterThanOrEqual(spec.states[0]!.rollBelow / 65536);
  });
});

describe("CatSpec", () => {
  it("is deterministic", () => {
    for (const { seed } of FIXTURE_SEEDS) {
      expect(buildCatSpec({ seed })).toEqual(buildCatSpec({ seed }));
    }
  });

  it("fixtures cover the expected cats", () => {
    const summary = FIXTURE_SEEDS.map(({ seed }) => {
      const c = buildCatSpec({ seed });
      return `${c.state} ${c.traits.breed.variant} ${c.traits.mood.variant} ${c.traits.accessory.variant} ${c.traits.brokenThing.variant} ${c.traits.room.variant} ${c.rarity.score} ${c.rarity.tier}`;
    });
    expect(summary).toEqual([
      "alive tabby unbothered bellCollar mug livingRoom 395 common",
      "asleep orange betrayed none vase bedroom 986 common",
      "ghost siamese judging crown tv serverRoom 2045 epic",
      "quantum glitch zoomies partyHat laptop theVoid 2807 legendary",
      "alive void plotting sunglasses wineGlass laboratory 1715 epic",
    ]);
  });

  it("fixtures match their snapshot", () => {
    expect(FIXTURE_SEEDS.map(({ seed }) => buildCatSpec({ seed }))).toMatchSnapshot();
  });

  it("applies state overrides", () => {
    const [, asleep, ghost, quantum] = FIXTURE_SEEDS.map(({ seed }) => buildCatSpec({ seed }));
    expect(asleep!.pose).toBe("curl");
    expect(asleep!.face.eyeShape).toBe("closed");
    expect(ghost!.render.ghost).toBe(true);
    expect(ghost!.render.opacity).toBeLessThan(1);
    expect(quantum!.animation.flicker).toBe(true);
    expect(quantum!.altBody).not.toBeNull();
    expect(quantum!.altBody!.pattern).not.toBe(quantum!.body.pattern);
  });

  it("reads vices from the cosmetic byte without touching traits or rarity", () => {
    const at = (cosmetic: number) => buildCatSpec({ seed: encodeSeed({ ...decodeSeed(FIXTURE_SEEDS[0]!.seed), cosmetic }) });
    const sober = at(1);
    const stoned = at(42);
    const drunk = at(13);
    expect([sober.vice, stoned.vice, drunk.vice]).toEqual(["none", "stoned", "drunk"]);
    expect(stoned.face.eyeShape).toBe("half");
    for (const cat of [stoned, drunk]) {
      expect(cat.traits).toEqual(sober.traits);
      expect(cat.rarity).toEqual(sober.rarity);
      expect(cat.pose).toBe(sober.pose);
    }
    const counts = { none: 0, stoned: 0, drunk: 0 };
    for (let c = 0; c < 256; c++) counts[at(c).vice]++;
    expect(counts).toEqual({ none: 250, stoned: 3, drunk: 3 });
  });

  it("turns the accessory golden only above the affection threshold", () => {
    const seed = FIXTURE_SEEDS[0]!.seed;
    const at = buildCatSpec({ seed, affection: spec.affection.goldenThreshold });
    const above = buildCatSpec({ seed, affection: spec.affection.goldenThreshold + 1 });
    expect(at.accessory.golden).toBe(false);
    expect(above.accessory.golden).toBe(true);
    expect(above.rarity.score - at.rarity.score).toBe(spec.affection.goldenScoreBonus);
    expect(above.rarity.tier).toBe(at.rarity.tier);
  });

  it("rejects a state that contradicts the seed", () => {
    expect(() => buildCatSpec({ seed: FIXTURE_SEEDS[0]!.seed, state: "ghost" })).toThrow();
    expect(() => buildCatSpec({ seed: FIXTURE_SEEDS[0]!.seed, state: 0 })).not.toThrow();
  });

  it("builds a valid spec for random seeds", () => {
    const rand = mulberry32(99);
    for (let i = 0; i < 2000; i++) {
      const seed = (BigInt(Math.floor(rand() * 2 ** 32)) << 32n) | BigInt(Math.floor(rand() * 2 ** 32));
      const c = buildCatSpec({ seed });
      expect(c.rarity.score).toBeLessThanOrEqual(spec.rarity.maxScore);
      expect(c.body.girth).toBeGreaterThan(0.7);
    }
  });
});

describe("BoxSpec", () => {
  it("is deterministic and depends on the token id only", () => {
    expect(buildBoxSpec(42)).toEqual(buildBoxSpec(42));
    expect(buildBoxSpec(42)).not.toEqual(buildBoxSpec(43));
    expect(buildBoxSpec(7).serial).toBe("DNO-0007");
  });

  it("rejects ids that are not token ids", () => {
    expect(() => buildBoxSpec(-1)).toThrow(RangeError);
    // Ids run past the supply: every mint creates ten, sold or empty.
    expect(buildBoxSpec(spec.collection.maxSupply).serial).toBe(`DNO-${spec.collection.maxSupply}`);
    expect(() => buildBoxSpec(2 ** 32)).toThrow(RangeError);
  });
});

describe("metadata and SVG fallback", () => {
  it("builds sealed metadata from the token id and public facts only", async () => {
    const { sealedMetadata, renderBoxSvg, buildBoxSpec } = await import("../src");
    const meta = sealedMetadata(42, "42.png", { duelsWon: 3, vetCertified: true });
    expect(meta.name).toBe("DO NOT OPEN DNO-0042");
    expect(meta.attributes.map((a) => a.trait_type)).toEqual(["Status", "Duels won", "Vet Certified"]);
    const svg = renderBoxSvg(buildBoxSpec(42));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("DNO-0042");
    expect(renderBoxSvg(buildBoxSpec(42))).toBe(svg);
  });

  it("lists every revealed trait and draws every fixture", async () => {
    const { revealedMetadata, renderCatSvg, buildCatSpec, FIXTURE_SEEDS } = await import("../src");
    for (const { seed } of FIXTURE_SEEDS) {
      const cat = buildCatSpec({ seed, affection: 11 });
      const meta = revealedMetadata(7, cat, "7.png");
      const value = (t: string) => meta.attributes.find((a) => a.trait_type === t)?.value;
      expect(value("Breed")).toBe(cat.traits.breed.name);
      expect(value("Rarity score")).toBe(cat.rarity.score);
      expect(String(value("Accessory"))).toMatch(/^Golden /);
      const svg = renderCatSvg(cat);
      expect(svg).not.toContain("undefined");
      expect(svg).not.toContain("NaN");
    }
  });
});

describe("weigh-in", () => {
  const { seed } = FIXTURE_SEEDS[0]!;
  const builds = spec.economy.weight.builds;

  it("picks the heaviest build a weight reaches, like the Pantry", () => {
    expect(buildForWeight(0).key).toBe("thin");
    expect(buildForWeight(1).key).toBe("normal");
    for (const b of builds) {
      expect(buildForWeight(b.minWeight).key).toBe(b.key);
      if (b.minWeight > 0) expect(buildForWeight(b.minWeight - 1).key).not.toBe(b.key);
    }
    expect(buildForWeight(10n ** 12n).key).toBe("huge");
  });

  it("leaves an unweighed cat untouched", () => {
    expect(buildCatSpec({ seed }).weight).toBeNull();
  });

  it("adds the build bonus, and the sick bonus, to the score and rounds the body", () => {
    const plain = buildCatSpec({ seed });
    const fat = buildCatSpec({ seed, weighIn: { weight: 60_000, sick: false, disease: null } });
    expect(fat.weight).toMatchObject({ build: "fat", buildName: "Fat", sick: false, disease: null, weight: 60_000 });
    expect(fat.rarity.score).toBe(plain.rarity.score + builds.find((b) => b.key === "fat")!.scoreBonus);
    expect(fat.rarity.tier).toBe(plain.rarity.tier);
    expect(fat.body.girth).toBeCloseTo(plain.body.girth * BUILD_GIRTH.fat, 2);

    const sick = buildCatSpec({ seed, weighIn: { weight: 400_000n, sick: true, disease: "diabetic" } });
    expect(sick.weight).toMatchObject({ build: "huge", sick: true, disease: "diabetic", diseaseName: "Diabetic" });
    expect(sick.rarity.score).toBe(
      plain.rarity.score + builds.find((b) => b.key === "huge")!.scoreBonus + spec.economy.weight.sick.scoreBonus,
    );
  });

  it("ignores a disease on a cat that is not sick", () => {
    expect(buildCatSpec({ seed, weighIn: { weight: 5, sick: false, disease: "arthritic" } }).weight?.disease).toBeNull();
  });

  it("puts the weigh-in in the metadata", () => {
    const sick = buildCatSpec({ seed, weighIn: { weight: 400_000, sick: true, disease: "fattyLiver" } });
    const attrs = revealedMetadata(1, sick, "1.png").attributes;
    expect(attrs).toContainEqual({ trait_type: "Build", value: "Huge" });
    expect(attrs).toContainEqual({ trait_type: "Weight", value: 400_000, display_type: "number" });
    expect(attrs).toContainEqual({ trait_type: "Disease", value: "Fatty liver" });
    const plain = revealedMetadata(1, buildCatSpec({ seed }), "1.png").attributes.map((a) => a.trait_type);
    expect(plain).not.toContain("Build");
  });
});
