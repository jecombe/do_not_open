import { describe, expect, it } from "vitest";
import { buildRatSpec, renderRatSvg } from "../src";

describe("rats", () => {
  it("draws the same rat from the same seed, and different rats from others", () => {
    expect(buildRatSpec(42n)).toEqual(buildRatSpec(42n));
    const looks = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(buildRatSpec(BigInt(i * 7919 + 1)))));
    expect(looks.size).toBe(40);
  });

  it("uses every coat, pose, face, eyes, hat and prop over enough seeds", () => {
    const rats = Array.from({ length: 2000 }, (_, i) => buildRatSpec(BigInt(i) * 0x9e3779b97f4a7c15n));
    for (const key of ["coat", "pose", "face", "eyes", "hat", "prop"] as const) {
      expect(new Set(rats.map((r) => r[key])).size).toBeGreaterThan(2);
    }
  });

  it("draws a flat picture of it", () => {
    const svg = renderRatSvg(buildRatSpec(7n));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("undefined");
    expect(svg).not.toContain("NaN");
  });
});
