import jpeg from "jpeg-js";
import type { ImageShrinker } from "../../application/ports/rats";

/**
 * Brings a JPEG under a byte budget, in plain JavaScript (no native module in the image):
 * halves its size while it is larger than `maxSide`, then lowers the quality until it fits.
 * An AI rat's picture so fits Arweave's free uploads, like the cats' pictures.
 */
export class JpegShrinker implements ImageShrinker {
  constructor(private readonly maxSide = 512) {}

  shrink(bytes: Uint8Array, maxBytes: number): Uint8Array {
    let img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
    while (Math.max(img.width, img.height) > this.maxSide) img = halve(img);
    for (const quality of [82, 72, 62, 52, 42, 32]) {
      const out = jpeg.encode({ data: img.data, width: img.width, height: img.height }, quality).data;
      if (out.byteLength <= maxBytes) return new Uint8Array(out);
    }
    // Still too large: a smaller picture, at a plain quality.
    img = halve(img);
    const out = jpeg.encode({ data: img.data, width: img.width, height: img.height }, 60).data;
    if (out.byteLength > maxBytes) throw new Error(`the picture does not fit ${maxBytes} bytes`);
    return new Uint8Array(out);
  }
}

/** Half the width and height, each pixel the mean of the four it replaces. */
function halve(img: { width: number; height: number; data: Uint8Array }): { width: number; height: number; data: Uint8Array } {
  const width = Math.max(1, img.width >> 1);
  const height = Math.max(1, img.height >> 1);
  const data = new Uint8Array(width * height * 4);
  const src = img.data;
  const w = img.width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        const a = ((2 * y) * w + 2 * x) * 4 + c;
        const b = a + 4;
        const d = a + w * 4;
        data[(y * width + x) * 4 + c] = (src[a]! + src[b]! + src[d]! + src[d + 4]!) >> 2;
      }
    }
  }
  return { width, height, data };
}
