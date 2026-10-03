/**
 * Renders the site's sharing and install images into public/: the social card (og.png,
 * 1200x630, for Open Graph and Twitter), the app icons drawn from favicon.svg
 * (apple-touch-icon.png, icon-192.png, icon-512.png, icon-512-maskable.png) and the
 * site.webmanifest that lists them.
 *
 *   pnpm --filter @dno/web render:og
 *   pnpm --filter @dno/web render:og --stills <dir>     also keep the raw 3D stills
 *
 * The card's box and cats are drawn by the same builders as the app and the token metadata
 * (render.html, src/render), in headless Chrome. CHROME_PATH points at a specific Chrome or
 * Chromium binary. The box is drawn from a token id only, like every sealed box; the cats
 * are the generator's fixture seeds, not anyone's token.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { buildCatSpec, FIXTURE_SEEDS } from "@dno/generator";

const root = resolve(__dirname, "..");
const pub = resolve(root, "public");
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DOCK = "#17130F";
const SUN = "#FFD66B";
const PAPER = "#F6EEDB";
const RED = "#C2261D";
/** The sealed box on the card: any token id draws the same kind of box. */
const BOX_TOKEN = 7;
/** Three fixture cats for the strip (indexes into FIXTURE_SEEDS). */
const CATS = [0, 1, 4];

const font = (file: string) => readFileSync(resolve(root, "node_modules/@fontsource", file)).toString("base64");
const png = (buffer: Buffer) => `data:image/png;base64,${buffer.toString("base64")}`;

function fontFaces(): string {
  return [
    ["Stardos Stencil", 700, "stardos-stencil/files/stardos-stencil-latin-700-normal.woff2"],
    ["Barlow Condensed", 500, "barlow-condensed/files/barlow-condensed-latin-500-normal.woff2"],
    ["Barlow Condensed", 700, "barlow-condensed/files/barlow-condensed-latin-700-normal.woff2"],
  ]
    .map(([family, weight, file]) => `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${font(file as string)}) format("woff2")}`)
    .join("");
}

function cardHtml(box: Buffer, cats: Buffer[]): string {
  const strip = cats
    .map((cat, i) => `<div class="cat" style="transform:rotate(${[-5, 3, -2][i]}deg)"><img src="${png(cat)}"></div>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces()}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden;background:${DOCK}}
body{position:relative;font-family:"Barlow Condensed",sans-serif;color:${PAPER};-webkit-font-smoothing:antialiased}
.box{position:absolute;right:-90px;top:-80px;width:790px;height:790px;
  -webkit-mask-image:radial-gradient(closest-side at 50% 50%,#000 62%,transparent 100%)}
.glow{position:absolute;right:40px;top:120px;width:520px;height:420px;border-radius:50%;
  background:radial-gradient(closest-side,rgb(255 214 107 / .10),transparent)}
.tape{position:absolute;left:0;top:0;width:100%;height:14px;
  background:repeating-linear-gradient(-45deg,${SUN} 0 22px,${DOCK} 22px 44px);opacity:.9}
.tape.bottom{top:auto;bottom:0}
.text{position:absolute;left:64px;top:62px;width:600px}
.stamp{display:inline-block;padding:.16em .42em .06em;border:.1em solid ${RED};outline:.035em solid ${RED};outline-offset:-.22em;
  background:${PAPER};color:${RED};font-family:"Stardos Stencil",sans-serif;font-weight:700;font-size:78px;line-height:1;white-space:nowrap;
  letter-spacing:.03em;text-transform:uppercase;transform:rotate(-4deg);transform-origin:left center;box-shadow:8px 8px 0 #000}
.tagline{margin-top:38px;font-weight:700;font-size:48px;line-height:1.08;text-transform:uppercase;letter-spacing:.005em}
.tagline em{font-style:normal;color:${SUN}}
.cats{position:absolute;left:68px;bottom:96px;display:flex;gap:22px}
.cat{width:124px;height:124px;border:4px solid ${SUN};border-radius:14px;overflow:hidden;background:${DOCK};box-shadow:6px 6px 0 #000}
.cat img{width:100%;height:100%;object-fit:cover;transform:scale(1.75);transform-origin:50% 66%}
.cats-note{align-self:center;margin-left:6px;font-family:"Stardos Stencil",sans-serif;font-size:64px;line-height:1;color:${SUN}}
.foot{position:absolute;left:64px;right:64px;bottom:38px;display:flex;justify-content:space-between;align-items:baseline;
  font-weight:500;font-size:27px;letter-spacing:.06em;text-transform:uppercase;color:rgb(246 238 219 / .78)}
.foot b{font-weight:700;color:${SUN};text-transform:none;letter-spacing:.03em}
</style></head><body>
<div class="glow"></div>
<img class="box" src="${png(box)}">
<div class="tape"></div>
<div class="text">
  <div class="stamp">Do not open</div>
  <p class="tagline">10,000 sealed boxes.<br>One cat in each.<br><em>Nobody knows which.</em></p>
</div>
<div class="cats">${strip}<div class="cats-note">?</div></div>
<div class="foot"><span>Confidential NFTs on <b>Zama fhEVM</b></span><span>do-not-open.app</span></div>
<div class="tape bottom"></div>
</body></html>`;
}

/** The favicon's art centred on the dock colour, `scale` of the side (rounded corners off). */
function iconHtml(size: number, scale: number): string {
  const svg = readFileSync(resolve(pub, "favicon.svg"), "utf8");
  const art = Math.round(size * scale);
  return `<!doctype html><html><head><style>html,body{margin:0;width:${size}px;height:${size}px;background:${DOCK};overflow:hidden}
div{position:absolute;left:${(size - art) / 2}px;top:${(size - art) / 2}px;width:${art}px;height:${art}px;border-radius:${art * 0.14}px;overflow:hidden}
svg{display:block;width:100%;height:100%}</style></head><body><div>${svg}</div></body></html>`;
}

// --- A small indexed-colour PNG writer, so the card stays light without an image library. ---

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  let crc = -1;
  for (const byte of Buffer.concat([head.subarray(4), data])) crc = CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ -1) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

/** Median cut down to 256 colours, then a nearest-colour map (no dithering: flat art, smooth fog). */
function quantize(rgba: Uint8Array, width: number, height: number): Buffer {
  const count = width * height;
  type Bucket = number[];
  let buckets: Bucket[] = [Array.from({ length: count }, (_, i) => i)];
  const range = (b: Bucket, c: number) => {
    let lo = 255, hi = 0;
    for (const i of b) {
      const v = rgba[i * 4 + c]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  };
  while (buckets.length < 256) {
    let best = -1, bestScore = 0, bestChannel = 0;
    buckets.forEach((b, n) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        const score = range(b, c) * Math.sqrt(b.length);
        if (score > bestScore) [best, bestScore, bestChannel] = [n, score, c];
      }
    });
    if (best < 0) break;
    const b = buckets[best]!.sort((x, y) => rgba[x * 4 + bestChannel]! - rgba[y * 4 + bestChannel]!);
    const half = b.length >> 1;
    buckets = [...buckets.slice(0, best), b.slice(0, half), b.slice(half), ...buckets.slice(best + 1)];
  }
  const palette = buckets.map((b) => [0, 1, 2].map((c) => Math.round(b.reduce((s, i) => s + rgba[i * 4 + c]!, 0) / b.length)));
  const cache = new Map<number, number>();
  const nearest = (r: number, g: number, b: number) => {
    const key = (r << 16) | (g << 8) | b;
    let hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0, dist = Infinity;
    palette.forEach(([pr, pg, pb], n) => {
      const d = 2 * (r - pr!) ** 2 + 4 * (g - pg!) ** 2 + 3 * (b - pb!) ** 2;
      if (d < dist) [best, dist] = [n, d];
    });
    cache.set(key, best);
    return best;
  };
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[y * (width + 1) + 1 + x] = nearest(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 3, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(palette.flat())),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const manifest = {
  name: "DO NOT OPEN",
  short_name: "DO NOT OPEN",
  description: "10,000 sealed boxes. One cat in each. Nobody knows which. Confidential NFTs on Zama fhEVM.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: DOCK,
  theme_color: DOCK,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

async function main() {
  const { createServer } = await import("vite");
  const { chromium } = await import("playwright-core");
  const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), server: { port: 0 }, logLevel: "error" });
  await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    // Software GL is enough for a few still frames, and works on a machine with no GPU.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    const still = async (query: string) => {
      await page.goto(`${url}render.html?${query}`);
      await page.waitForFunction("window.__dnoRender || window.__dnoRenderError", undefined, { timeout: 60_000 });
      const error = await page.evaluate("window.__dnoRenderError");
      if (error) throw new Error(`${query}: ${error}`);
      const dataUrl = (await page.evaluate("window.__dnoRender")) as string;
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    };

    const box = await still(`token=${BOX_TOKEN}`);
    const cats: Buffer[] = [];
    for (const index of CATS) {
      const cat = buildCatSpec({ seed: FIXTURE_SEEDS[index]!.seed });
      cats.push(await still(`token=${index}&seed=${cat.seed}&affection=${cat.affection}`));
    }
    const keep = option("stills");
    if (keep) {
      mkdirSync(keep, { recursive: true });
      writeFileSync(resolve(keep, "box.png"), box);
      cats.forEach((cat, i) => writeFileSync(resolve(keep, `cat-${CATS[i]}.png`), cat));
    }

    // The card: laid out in HTML, screenshotted, then cut down to an indexed PNG.
    const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await card.setContent(cardHtml(box, cats), { waitUntil: "load" });
    await card.evaluate("document.fonts.ready");
    const shot = await card.screenshot({ type: "png" });
    // Decode the screenshot in the page, where a canvas is at hand.
    const rgba = (await card.evaluate(async (src: string) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(0, 0, c.width, c.height).data);
    }, png(shot))) as number[];
    writeFileSync(resolve(pub, "og.png"), quantize(Uint8Array.from(rgba), 1200, 630));
    console.log("  og.png");

    // The icons: the favicon's box on the dock colour. The maskable one keeps its art inside
    // the central 80% circle that every launcher mask leaves visible.
    const icons: [string, number, number][] = [
      ["apple-touch-icon.png", 180, 0.78],
      ["icon-192.png", 192, 0.78],
      ["icon-512.png", 512, 0.78],
      ["icon-512-maskable.png", 512, 0.54],
    ];
    for (const [name, size, scale] of icons) {
      const icon = await browser.newPage({ viewport: { width: size, height: size } });
      await icon.setContent(iconHtml(size, scale));
      writeFileSync(resolve(pub, name), await icon.screenshot({ type: "png" }));
      await icon.close();
      console.log(`  ${name}`);
    }
    writeFileSync(resolve(pub, "site.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");
    console.log("  site.webmanifest");
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
