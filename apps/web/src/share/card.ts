import type { CatSpec } from "@dno/generator";
import { renderStill } from "../render/still";

export type CardFormat = "post" | "story";

/** 4:5 sits whole in a feed (X, Instagram); 9:16 fills a story or a TikTok. */
const SIZES: Record<CardFormat, { width: number; height: number }> = {
  post: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
};

const INK = "#1c1814";
const MANIFEST = "#e9dfc8";
const TAPE = "#d9c28a";
const INK_RED = "#c2261d";
const SHADOW = "#17130f";
const STENCIL = '"Stardos Stencil", "Arial Black", sans-serif';
const LABEL = '"Barlow Condensed", "Arial Narrow", sans-serif';

/** Everything the card writes, already in the reader's language. */
export interface CardText {
  serial: string;
  /** Small caps over the serial: "Declaration" or "Consignment". */
  head: string;
  /** Right of the head, boxed like the app's tier mark. */
  badge?: string;
  /** Up to three short lines under the serial. */
  lines: string[];
  /** The rubber stamp across the slip. */
  stamp: string;
  /** Printed last, on the slip: where to find the box. */
  where: string;
}

/** A picture of the box (or its cat) on the dock, with a slip in the app's paper and a stamp. */
export async function drawCard({ tokenId, cat, text, format }: { tokenId: number; cat: CatSpec | null; text: CardText; format: CardFormat }): Promise<Blob> {
  const { width: W, height: H } = SIZES[format];
  await Promise.all([`700 64px ${STENCIL}`, `500 32px ${LABEL}`, `700 64px ${LABEL}`].map((f) => document.fonts.load(f))).catch(() => undefined);
  const still = await renderStill({ tokenId, cat, size: 1080 });

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  g.fillStyle = SHADOW;
  g.fillRect(0, 0, W, H);

  // The scene fills the card, held high so the slip covers floor, not cat.
  const side = format === "story" ? 1300 : W;
  g.drawImage(still, (W - side) / 2, format === "story" ? 100 : -120, side, side);

  // Darken top and bottom so the tape and the slip stand out.
  const shade = g.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, "rgb(23 19 15 / 0.85)");
  shade.addColorStop(0.16, "rgb(23 19 15 / 0)");
  shade.addColorStop(0.55, "rgb(23 19 15 / 0)");
  shade.addColorStop(1, "rgb(23 19 15 / 0.9)");
  g.fillStyle = shade;
  g.fillRect(0, 0, W, H);

  tape(g, W, format === "story" ? 120 : 56);
  slip(g, W, H, text, format);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas is empty"))), "image/png"));
}

/** Warning tape across the top, "DO NOT OPEN" printed on it. */
function tape(g: CanvasRenderingContext2D, W: number, y: number) {
  const h = 92;
  g.save();
  g.translate(W / 2, y + h / 2);
  g.rotate(-0.025);
  g.translate(-W / 2 - 40, -h / 2);
  const w = W + 80;
  g.fillStyle = TAPE;
  g.fillRect(0, 0, w, h);
  // Hazard stripes along both edges.
  g.save();
  g.beginPath();
  g.rect(0, 0, w, 14);
  g.rect(0, h - 14, w, 14);
  g.clip();
  g.fillStyle = INK;
  for (let x = -h; x < w + h; x += 36) {
    g.beginPath();
    g.moveTo(x, h);
    g.lineTo(x + 18, h);
    g.lineTo(x + 18 + h, 0);
    g.lineTo(x + h, 0);
    g.fill();
  }
  g.restore();
  g.fillStyle = INK;
  g.font = `700 60px ${STENCIL}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("DO NOT OPEN  ·  DO NOT OPEN  ·  DO NOT OPEN", w / 2, h / 2 + 3);
  g.restore();
}

/** The paper slip at the bottom, as the app lays it over the scene. */
function slip(g: CanvasRenderingContext2D, W: number, H: number, text: CardText, format: CardFormat) {
  const pad = 44;
  const w = W - 2 * 64;
  const lineH = 46;
  const firstLine = pad + 218;
  const rule = firstLine + (text.lines.length - 1) * lineH + 30;
  const h = rule + 44 + pad - 6;
  const x = 64;
  const y = H - h - (format === "story" ? 190 : 64);

  g.save();
  g.translate(x + w / 2, y + h / 2);
  g.rotate(-0.012);
  g.translate(-w / 2, -h / 2);
  g.shadowColor = "rgb(0 0 0 / 0.55)";
  g.shadowBlur = 50;
  g.shadowOffsetY = 22;
  g.fillStyle = MANIFEST;
  g.fillRect(-10, -10, w + 20, h + 20);
  g.shadowColor = "transparent";
  g.strokeStyle = INK;
  g.lineWidth = 4;
  g.strokeRect(0, 0, w, h);

  g.fillStyle = INK;
  g.textBaseline = "alphabetic";
  g.textAlign = "left";
  g.font = `600 36px ${LABEL}`;
  g.fillText(text.head.toUpperCase(), pad, pad + 30);
  if (text.badge) {
    g.font = `700 36px ${LABEL}`;
    const bw = g.measureText(text.badge).width + 32;
    g.fillRect(w - pad - bw, pad - 4, bw, 48);
    g.fillStyle = MANIFEST;
    g.textAlign = "center";
    g.fillText(text.badge, w - pad - bw / 2, pad + 30);
    g.fillStyle = INK;
    g.textAlign = "left";
  }

  g.font = `700 124px ${LABEL}`;
  g.fillText(text.serial, pad - 4, pad + 160);

  g.font = `500 38px ${LABEL}`;
  text.lines.forEach((line, i) => g.fillText(fit(g, line, w - 2 * pad), pad, firstLine + i * lineH));

  g.fillRect(pad, rule, w - 2 * pad, 3);
  g.font = `600 30px ${LABEL}`;
  g.fillText(fit(g, text.where, w - 2 * pad), pad, rule + 44);

  // Without a badge the stamp sits higher, clear of the lines.
  stamp(g, w - 235, text.badge ? pad + 125 : pad + 100, text.stamp);
  g.restore();
}

/** A red rubber stamp, a bit crooked and a bit worn. Inked on its own sheet so the wear only takes ink. */
export function stamp(g: CanvasRenderingContext2D, cx: number, cy: number, word: string) {
  const sheet = document.createElement("canvas");
  sheet.width = 560;
  sheet.height = 160;
  const s = sheet.getContext("2d")!;
  s.translate(sheet.width / 2, sheet.height / 2);
  s.font = `700 64px ${STENCIL}`;
  const tw = Math.min(s.measureText(word).width, 380);
  s.strokeStyle = INK_RED;
  s.fillStyle = INK_RED;
  s.lineWidth = 7;
  s.strokeRect(-tw / 2 - 24, -48, tw + 48, 96);
  s.lineWidth = 2.5;
  s.strokeRect(-tw / 2 - 14, -38, tw + 28, 76);
  s.textAlign = "center";
  s.textBaseline = "middle";
  s.fillText(word, 0, 5, 380);
  s.globalCompositeOperation = "destination-out";
  let n = word.length * 7919 + 1;
  const rand = () => (n = (n * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) {
    s.beginPath();
    s.arc((rand() - 0.5) * (tw + 60), (rand() - 0.5) * 116, rand() * 3.2, 0, Math.PI * 2);
    s.fill();
  }

  g.save();
  g.translate(cx, cy);
  g.rotate(-0.2);
  g.globalAlpha = 0.86;
  g.drawImage(sheet, -sheet.width / 2, -sheet.height / 2);
  g.restore();
}

/** Shortens a line with an ellipsis until it fits. */
export function fit(g: CanvasRenderingContext2D, line: string, max: number): string {
  if (g.measureText(line).width <= max) return line;
  let s = line;
  while (s.length > 1 && g.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}
