import { CanvasTexture, SRGBColorSpace } from "three";
import { mulberry32, type BoxSpec } from "@dno/generator";

export interface TextureOptions {
  /** Canvas factory. Override for headless renders. */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  /** CSS font families. They must be loaded before building, or the canvas falls back. */
  stencilFont?: string;
  labelFont?: string;
}

const defaults = {
  createCanvas: (w: number, h: number) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  },
  stencilFont: '"Stardos Stencil", "Arial Black", sans-serif',
  labelFont: '"Barlow Condensed", "Arial Narrow", sans-serif',
};

export const INK_RED = "#B3241B";
export const KRAFT = "#B8895A";

function finish(canvas: HTMLCanvasElement): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Kraft cardboard: fibre noise, faint corrugation lines, scuffs scaled by wear. */
export function cardboardTexture(seed: number, wear: number, opts: TextureOptions = {}): CanvasTexture {
  const o = { ...defaults, ...opts };
  const size = 512;
  const canvas = o.createCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(seed);
  ctx.fillStyle = KRAFT;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 2600; i++) {
    const light = rand() > 0.5;
    ctx.strokeStyle = light ? `rgba(226,190,140,${0.05 + rand() * 0.1})` : `rgba(90,58,30,${0.04 + rand() * 0.1})`;
    ctx.lineWidth = 0.6 + rand();
    const x = rand() * size;
    const y = rand() * size;
    const len = 6 + rand() * 26;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rand() - 0.5) * 3);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(80,50,25,0.05)";
  ctx.lineWidth = 1;
  for (let y = 0; y < size; y += 9) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  const scuffs = Math.round(4 + wear * 22);
  for (let i = 0; i < scuffs; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 8 + rand() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rand() > 0.4;
    g.addColorStop(0, dark ? "rgba(60,38,20,0.22)" : "rgba(235,210,170,0.25)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Darker edges, as if handled a lot.
  const edge = ctx.createRadialGradient(size / 2, size / 2, size * 0.35, size / 2, size / 2, size * 0.75);
  edge.addColorStop(0, "rgba(0,0,0,0)");
  edge.addColorStop(1, "rgba(50,30,15,0.28)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);
  return finish(canvas);
}

/** Knocks holes in fresh ink so a stamp reads as rubber on cardboard. */
function distress(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number, amount: number) {
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 500 + amount * 1800; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.3 + rand() * 0.7})`;
    const s = 1 + rand() * (2 + amount * 4);
    ctx.fillRect(rand() * w, rand() * h, s, s * (0.4 + rand()));
  }
  for (let i = 0; i < 4 + amount * 8; i++) {
    ctx.strokeStyle = `rgba(0,0,0,${0.35 + rand() * 0.4})`;
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    const y = rand() * h;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + (rand() - 0.5) * 30);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** The "DO NOT OPEN" rubber stamp, red ink on a transparent ground. */
export function stampTexture(seed: number, wear: number, opts: TextureOptions = {}): CanvasTexture {
  const o = { ...defaults, ...opts };
  const w = 1024;
  const h = 384;
  const canvas = o.createCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = INK_RED;
  ctx.fillStyle = INK_RED;
  ctx.lineWidth = 22;
  ctx.strokeRect(24, 24, w - 48, h - 48);
  ctx.lineWidth = 6;
  ctx.strokeRect(54, 54, w - 108, h - 108);
  ctx.font = `700 200px ${o.stencilFont}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("DO NOT OPEN", w / 2, h / 2 + 12, w - 150);
  distress(ctx, w, h, mulberry32(seed ^ 0x5717), 0.25 + wear * 0.6);
  return finish(canvas);
}

/** Printed "this side up" arrows for the side faces. */
export function arrowsTexture(opts: TextureOptions = {}): CanvasTexture {
  const o = { ...defaults, ...opts };
  const canvas = o.createCanvas(256, 256);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(48,30,18,0.82)";
  for (const x of [78, 178]) {
    ctx.beginPath();
    ctx.moveTo(x, 30);
    ctx.lineTo(x + 40, 92);
    ctx.lineTo(x + 16, 92);
    ctx.lineTo(x + 16, 170);
    ctx.lineTo(x - 16, 170);
    ctx.lineTo(x - 16, 92);
    ctx.lineTo(x - 40, 92);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillRect(30, 184, 196, 10);
  ctx.font = `600 34px ${o.labelFont}`;
  ctx.textAlign = "center";
  ctx.fillText("THIS SIDE UP", 128, 234);
  distress(ctx, 256, 256, mulberry32(7), 0.2);
  return finish(canvas);
}

/** Thermal shipping label. Everything printed here is public token data. */
export function labelTexture(spec: BoxSpec, opts: TextureOptions = {}): CanvasTexture {
  const o = { ...defaults, ...opts };
  const w = 768;
  const h = 512;
  const canvas = o.createCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(spec.noiseSeed ^ 0x1abe1);
  const ink = "#1C1814";
  ctx.fillStyle = "#EFE8D8";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 5;
  ctx.strokeRect(14, 14, w - 28, h - 28);

  const rule = (y: number) => {
    ctx.beginPath();
    ctx.moveTo(14, y);
    ctx.lineTo(w - 14, y);
    ctx.stroke();
  };
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = `500 30px ${o.labelFont}`;
  ctx.fillText("Lost parcel depot / consignment", 34, 56);
  ctx.font = `700 124px ${o.labelFont}`;
  ctx.fillText(spec.serial, 30, 172);
  rule(196);

  ctx.font = `500 28px ${o.labelFont}`;
  ctx.fillText("Dock", 34, 236);
  ctx.fillText("Weight", 200, 236);
  ctx.fillText("Contents", 400, 236);
  ctx.font = `700 54px ${o.labelFont}`;
  ctx.fillText(spec.dock, 34, 292);
  ctx.fillText(`${spec.weightKg.toFixed(1)} kg`, 200, 292);
  ctx.fillText("Undeclared", 400, 292);
  rule(316);

  // Barcode derived from the public serial only.
  let x = 34;
  while (x < w - 250) {
    const bar = 2 + Math.floor(rand() * 4) * 2;
    ctx.fillRect(x, 340, bar, 110);
    x += bar + 2 + Math.floor(rand() * 3) * 2;
  }
  ctx.font = `500 24px ${o.labelFont}`;
  ctx.fillText(`${spec.serial}  ${spec.noiseSeed.toString(16).toUpperCase().padStart(8, "0")}`, 34, 482);

  ctx.textAlign = "center";
  ctx.font = `700 40px ${o.labelFont}`;
  ctx.fillText("Alive?", w - 130, 384);
  ctx.font = `500 26px ${o.labelFont}`;
  ctx.fillText("Unknown until", w - 130, 420);
  ctx.fillText("observed", w - 130, 450);
  ctx.strokeRect(w - 236, 336, 212, 134);

  // Thermal print fade
  for (let i = 0; i < 40 + spec.wear * 120; i++) {
    ctx.fillStyle = `rgba(239,232,216,${0.25 + rand() * 0.4})`;
    ctx.fillRect(rand() * w, rand() * h, 2 + rand() * 60, 1 + rand() * 2);
  }
  return finish(canvas);
}
