import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { JpegShrinker } from "../src/infrastructure/rats/JpegShrinker";

/** A noisy 1024×1024 picture: the worst case for JPEG, like a detailed sketch. */
function noisy(size = 1024): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  let x = 12345;
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    data[i] = i % 4 === 3 ? 255 : (x >>> 16) & 0xff;
  }
  return new Uint8Array(jpeg.encode({ data, width: size, height: size }, 95).data);
}

describe("JpegShrinker", () => {
  it("brings a large picture under Arweave's free size, still a JPEG of at most 512 px", () => {
    const big = noisy();
    expect(big.byteLength).toBeGreaterThan(100 * 1024);
    const out = new JpegShrinker().shrink(big, 99 * 1024);
    expect(out.byteLength).toBeLessThanOrEqual(99 * 1024);
    const back = jpeg.decode(out);
    expect(Math.max(back.width, back.height)).toBeLessThanOrEqual(512);
  });

  it("refuses what is not a JPEG", () => {
    expect(() => new JpegShrinker().shrink(new Uint8Array([1, 2, 3]), 1000)).toThrow();
  });
});
