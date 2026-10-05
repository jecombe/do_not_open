import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, CircleGeometry, SRGBColorSpace } from "three";
import { mulberry32 } from "@dno/generator";
import { BOX_SIZE, type BoxObject } from "./buildBox";
import { distress, type TextureOptions } from "./textures";

/** First, second, third: gold, silver, bronze, as at a cat show. */
const METALS = [
  { face: "#E2B33C", pleat: "#C8962A", ribbon: "#B07F1E", ink: "#4A3208" },
  { face: "#C9CED3", pleat: "#A9B0B7", ribbon: "#8E979F", ink: "#2C3238" },
  { face: "#C98648", pleat: "#A9682F", ribbon: "#8E5424", ink: "#3A1F0A" },
] as const;

const PLACE = ["1ST", "2ND", "3RD"];

export interface RosetteSpec {
  /** 1, 2 or 3. */
  place: number;
  wins: number;
}

const metal = (place: number) => METALS[Math.min(Math.max(place, 1), 3) - 1]!;

/** The rosette's face: pleated ruffle all round, a medallion with the place and the wins. */
export function rosetteTexture(r: RosetteSpec, seed: number, opts: TextureOptions = {}): CanvasTexture {
  const size = 512;
  const canvas = opts.createCanvas?.(size, size) ?? Object.assign(document.createElement("canvas"), { width: size, height: size });
  const ctx = canvas.getContext("2d")! as CanvasRenderingContext2D;
  const m = metal(r.place);
  const font = opts.stencilFont ?? '"Stardos Stencil", "Arial Black", sans-serif';
  const c = size / 2;

  // The ruffle: pleats as alternating wedges with a scalloped rim.
  const pleats = 36;
  for (let i = 0; i < pleats; i++) {
    const a0 = (i / pleats) * Math.PI * 2;
    const a1 = ((i + 1) / pleats) * Math.PI * 2;
    ctx.fillStyle = i % 2 ? m.pleat : m.face;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, c - 6, a0, a1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c + Math.cos((a0 + a1) / 2) * (c - 10), c + Math.sin((a0 + a1) / 2) * (c - 10), 10, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = m.ink;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 3;
  for (let i = 0; i < pleats; i++) {
    const a = (i / pleats) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * 150, c + Math.sin(a) * 150);
    ctx.lineTo(c + Math.cos(a) * (c - 14), c + Math.sin(a) * (c - 14));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // The medallion, ringed twice.
  ctx.fillStyle = "#F4ECDA";
  ctx.beginPath();
  ctx.arc(c, c, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 14;
  ctx.strokeStyle = m.ribbon;
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(c, c, 124, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = m.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 40px ${font}`;
  ctx.fillText("DUELS", c, c - 76);
  ctx.font = `700 100px ${font}`;
  ctx.fillText(PLACE[r.place - 1] ?? `${r.place}`, c, c + 4, 220);
  ctx.font = `700 38px ${font}`;
  ctx.fillText(`${r.wins} ${r.wins === 1 ? "WIN" : "WINS"}`, c, c + 82, 200);

  distress(ctx, size, size, mulberry32(seed ^ 0x2057), 0.3);
  const tex = new CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** One ribbon tail, cut with a swallowtail notch at the end. */
function tailTexture(color: string, opts: TextureOptions): CanvasTexture {
  const w = 64;
  const h = 256;
  const canvas = opts.createCanvas?.(w, h) ?? Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d")! as CanvasRenderingContext2D;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, h);
  ctx.lineTo(w / 2, h - 34);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  // A darker fold line down the middle.
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(w / 2 - 2, 0, 4, h - 40);
  const tex = new CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

const RADIUS = 0.15;
const TAIL = { w: 0.075, h: 0.26 };

/**
 * A cat-show rosette pinned to the front of a box, top centre, over whatever is printed there:
 * the duel ranking's top three wear one. The tails sway a little; the box stays sealed.
 */
export class Rosette {
  readonly group = new Group();
  private readonly tails: Group[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly phase: number;

  constructor(
    box: BoxObject,
    readonly spec: RosetteSpec,
    private readonly opts: TextureOptions & { reducedMotion?: boolean } = {},
  ) {
    const m = metal(spec.place);
    const faceTex = rosetteTexture(spec, box.spec.noiseSeed, opts);
    const face = new MeshBasicMaterial({ map: faceTex, transparent: true, alphaTest: 0.05, polygonOffset: true, polygonOffsetFactor: -4 });
    const faceGeo = new CircleGeometry(RADIUS, 48);
    const tailTex = tailTexture(m.ribbon, opts);
    const tailMat = new MeshBasicMaterial({ map: tailTex, transparent: true, alphaTest: 0.5 });
    const tailGeo = new PlaneGeometry(TAIL.w, TAIL.h);
    tailGeo.translate(0, -TAIL.h / 2, 0);
    this.disposables.push(faceTex, face, faceGeo, tailTex, tailMat, tailGeo);

    // Tails first, behind the face, hanging from its centre and fanned out.
    for (const side of [-1, 1]) {
      const pivot = new Group();
      pivot.position.set(side * 0.03, -0.02, 0.004);
      pivot.rotation.z = side * 0.28;
      pivot.add(new Mesh(tailGeo, tailMat));
      this.group.add(pivot);
      this.tails.push(pivot);
    }
    const disc = new Mesh(faceGeo, face);
    disc.position.z = 0.012;
    this.group.add(disc);

    this.phase = box.spec.noiseSeed % 7;
    this.group.position.set(0.12, BOX_SIZE.height - 0.2, BOX_SIZE.depth / 2 + 0.01);
    this.group.rotation.z = -0.08 + box.spec.stampRotation * 0.3;
    this.group.name = "rosette";
    box.body.add(this.group);
  }

  update(time: number): void {
    if (this.opts.reducedMotion) return;
    for (const [i, t] of this.tails.entries()) {
      const side = i === 0 ? -1 : 1;
      t.rotation.z = side * 0.28 + Math.sin(time * 1.6 + this.phase + i) * 0.05;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
