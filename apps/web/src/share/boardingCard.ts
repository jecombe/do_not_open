import { fit, stamp } from "./card";

/** 16:9, the shape X and Discord show whole in a feed. */
const W = 1200;
const H = 675;

const INK = "#1c1814";
const MANIFEST = "#e9dfc8";
const TAPE = "#d9c28a";
const SHADOW = "#17130f";
const STENCIL = '"Stardos Stencil", "Arial Black", sans-serif';
const LABEL = '"Barlow Condensed", "Arial Narrow", sans-serif';

/** Everything the pass prints, already in the reader's language. */
export interface BoardingCardText {
  /** "Boarding pass". */
  title: string;
  /** Field labels: passenger, from, to, gate. */
  passenger: string;
  from: string;
  to: string;
  gate: string;
  /** The values under them. */
  handle: string;
  fromValue: string;
  toValue: string;
  gateValue: string;
  /** The pass code, big on the stub. */
  code: string;
  /** The rubber stamp: "Seated" or "Boarding". */
  stamp: string;
  /** Printed along the bottom: the referral link, without its scheme. */
  where: string;
  /** Over the link: "Board with my code". */
  invite: string;
}

/**
 * The player's boarding pass as a picture to post: paper ticket with a tear-off stub, warning tape
 * across the corner, a barcode drawn from the code, and the referral link printed at the bottom.
 */
export async function drawBoardingCard(text: BoardingCardText): Promise<Blob> {
  await Promise.all([`700 64px ${STENCIL}`, `500 32px ${LABEL}`, `700 64px ${LABEL}`].map((f) => document.fonts.load(f))).catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  g.fillStyle = SHADOW;
  g.fillRect(0, 0, W, H);

  const x = 70;
  const y = 92;
  const w = W - 2 * x;
  const h = H - 2 * y;
  const stubW = 300;
  const tear = x + w - stubW;

  g.save();
  g.translate(W / 2, H / 2);
  g.rotate(-0.015);
  g.translate(-W / 2, -H / 2);

  // The paper, with a notch either end of the tear line.
  g.shadowColor = "rgb(0 0 0 / 0.6)";
  g.shadowBlur = 50;
  g.shadowOffsetY = 20;
  g.fillStyle = MANIFEST;
  g.beginPath();
  g.rect(x, y, w, h);
  g.fill();
  g.shadowColor = "transparent";
  g.globalCompositeOperation = "destination-out";
  for (const cy of [y, y + h]) {
    g.beginPath();
    g.arc(tear, cy, 22, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = "source-over";
  g.fillStyle = SHADOW;
  for (const cy of [y, y + h]) {
    g.beginPath();
    g.arc(tear, cy, 22, 0, Math.PI * 2);
    g.fill();
  }

  // The tear line.
  g.strokeStyle = INK;
  g.lineWidth = 3;
  g.setLineDash([12, 10]);
  g.beginPath();
  g.moveTo(tear, y + 30);
  g.lineTo(tear, y + h - 30);
  g.stroke();
  g.setLineDash([]);

  // The ticket's head band.
  g.fillStyle = INK;
  g.fillRect(x, y, tear - x - 22, 74);
  g.fillStyle = MANIFEST;
  g.font = `700 46px ${STENCIL}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillText("DO NOT OPEN", x + 34, y + 40);
  g.font = `600 30px ${LABEL}`;
  g.textAlign = "right";
  g.fillText(text.title.toUpperCase(), tear - 52, y + 40);

  // The fields.
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  const col = (label: string, value: string, fx: number, fy: number, size: number, maxW: number) => {
    g.fillStyle = INK;
    g.globalAlpha = 0.7;
    g.font = `600 24px ${LABEL}`;
    g.fillText(label.toUpperCase(), fx, fy);
    g.globalAlpha = 1;
    g.font = `700 ${size}px ${LABEL}`;
    g.fillText(fit(g, value, maxW), fx, fy + size + 4);
  };
  const left = x + 34;
  const inner = tear - left - 50;
  col(text.passenger, text.handle, left, y + 128, 76, inner);
  col(text.from, text.fromValue, left, y + 278, 52, inner / 3 - 20);
  col(text.to, text.toValue, left + inner / 3, y + 278, 52, inner / 3 - 20);
  col(text.gate, text.gateValue, left + (2 * inner) / 3, y + 278, 52, inner / 3 - 20);

  // The referral link along the bottom.
  g.fillRect(left, y + h - 92, inner, 3);
  g.globalAlpha = 0.7;
  g.font = `600 22px ${LABEL}`;
  g.fillText(text.invite.toUpperCase(), left, y + h - 58);
  g.globalAlpha = 1;
  g.font = `700 30px ${LABEL}`;
  g.fillText(fit(g, text.where, inner), left, y + h - 24);

  // The stub: the code, written big, and a barcode drawn from it.
  const sx = tear + 34;
  const sw = stubW - 68;
  g.globalAlpha = 0.7;
  g.font = `600 24px ${LABEL}`;
  g.fillText(text.title.toUpperCase(), sx, y + 56);
  g.globalAlpha = 1;
  g.font = `700 44px ${LABEL}`;
  g.fillText(fit(g, text.code, sw), sx, y + 110);
  barcode(g, sx, y + 150, sw, 150, text.code);
  g.restore();

  tape(g);
  // Across the tear line, under the barcode, as a gate agent would stamp it.
  stamp(g, tear + 40, y + 420, text.stamp);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas is empty"))), "image/png"));
}

/** Bars of varying width, the same for the same code. Decorative: nothing reads it. */
function barcode(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, code: string) {
  let n = [...code].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 2147483647, 7);
  const rand = () => (n = (n * 16807) % 2147483647) / 2147483647;
  g.fillStyle = INK;
  for (let bx = x; bx < x + w; ) {
    const bar = 2 + Math.floor(rand() * 5);
    if (bx + bar > x + w) break;
    g.fillRect(bx, y, bar, h);
    bx += bar + 2 + Math.floor(rand() * 5);
  }
}

/** Warning tape across the top left corner. */
function tape(g: CanvasRenderingContext2D) {
  const h = 60;
  const w = 560;
  g.save();
  g.translate(150, 70);
  g.rotate(-0.32);
  g.translate(-w / 2, -h / 2);
  g.fillStyle = TAPE;
  g.fillRect(0, 0, w, h);
  g.save();
  g.beginPath();
  g.rect(0, 0, w, 9);
  g.rect(0, h - 9, w, 9);
  g.clip();
  g.fillStyle = INK;
  for (let x = -h; x < w + h; x += 26) {
    g.beginPath();
    g.moveTo(x, h);
    g.lineTo(x + 13, h);
    g.lineTo(x + 13 + h, 0);
    g.lineTo(x + h, 0);
    g.fill();
  }
  g.restore();
  g.fillStyle = INK;
  g.font = `700 34px ${STENCIL}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("DO NOT OPEN  ·  DO NOT OPEN", w / 2, h / 2 + 2);
  g.restore();
}
