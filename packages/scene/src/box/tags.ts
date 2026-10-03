import { BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from "three";
import { mulberry32 } from "@dno/generator";
import { BOX_SIZE, type BoxObject } from "./buildBox";
import { distress, type TextureOptions } from "./textures";

/** What a box is tagged with: a duel, an entanglement (or a proposal of one), duels won. All public on-chain facts. */
export type BoxTagKind = "duel" | "entangled" | "champion";

export interface BoxTagSpec {
  kind: BoxTagKind;
  /** Printed big, e.g. "ON DUEL". The caller words it, in the reader's language. */
  title: string;
  /** Printed under it, e.g. "6 days left" or "with DNO-0042". */
  detail: string;
}

const INK: Record<BoxTagKind, string> = { duel: "#B3241B", entangled: "#2D4F8C", champion: "#8A6410" };
const MANILA = "#EADCB8";
/** Each kind's own front corner: the duel on the right, the thread on the left. The champion
 *  takes whichever corner is free, and stays off a box that already wears both. */
const SIDE: Partial<Record<BoxTagKind, 1 | -1>> = { duel: 1, entangled: -1 };
const SEED: Record<BoxTagKind, number> = { duel: 0xd0e1, entangled: 0xe47a, champion: 0xc4a3 };

/** The corner each tag hangs from: its own, or for the champion the one left free. */
export function tagSides(tags: readonly BoxTagSpec[]): Map<BoxTagKind, 1 | -1> {
  const sides = new Map<BoxTagKind, 1 | -1>();
  for (const t of tags) {
    const own = SIDE[t.kind];
    if (own) sides.set(t.kind, own);
  }
  if (tags.some((t) => t.kind === "champion")) {
    const taken = new Set(sides.values());
    const free = ([1, -1] as const).find((s) => !taken.has(s));
    if (free) sides.set("champion", free);
  }
  return sides;
}
const TAG_W = 0.3;
const TAG_H = 0.36;
const STRING = 0.07;
const TEX_W = 320;
const TEX_H = 384;

const canvasFor = (opts: TextureOptions) =>
  (opts.createCanvas?.(TEX_W, TEX_H) ?? Object.assign(document.createElement("canvas"), { width: TEX_W, height: TEX_H })) as HTMLCanvasElement;

const finish = (canvas: HTMLCanvasElement) => {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
};

/** The tag's outline, clipped top corners. */
function outline(ctx: CanvasRenderingContext2D) {
  const cut = 70;
  ctx.beginPath();
  ctx.moveTo(cut, 4);
  ctx.lineTo(TEX_W - cut, 4);
  ctx.lineTo(TEX_W - 4, cut);
  ctx.lineTo(TEX_W - 4, TEX_H - 4);
  ctx.lineTo(4, TEX_H - 4);
  ctx.lineTo(4, cut);
  ctx.closePath();
}

/** The back of a tag: blank manila, the same shape. */
export function tagBackTexture(opts: TextureOptions = {}): CanvasTexture {
  const canvas = canvasFor(opts);
  const ctx = canvas.getContext("2d")!;
  outline(ctx);
  ctx.fillStyle = MANILA;
  ctx.fill();
  return finish(canvas);
}

/** A manila luggage tag: clipped top corners, an eyelet, the title in stencil, the detail under it. */
export function tagTexture(tag: BoxTagSpec, seed: number, opts: TextureOptions = {}): CanvasTexture {
  const canvas = canvasFor(opts);
  const ctx = canvas.getContext("2d")!;
  const stencil = opts.stencilFont ?? '"Stardos Stencil", "Arial Black", sans-serif';
  const label = opts.labelFont ?? '"Barlow Condensed", "Arial Narrow", sans-serif';
  const ink = INK[tag.kind];
  outline(ctx);
  ctx.fillStyle = MANILA;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(60,40,20,0.55)";
  ctx.stroke();
  // The eyelet the string goes through.
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(TEX_W / 2, 40, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(TEX_W / 2, 40, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  // A band of ink across, the title knocked out of it.
  ctx.fillStyle = ink;
  ctx.fillRect(4, 104, TEX_W - 8, 116);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = MANILA;
  fitText(ctx, tag.title.toUpperCase(), 700, 76, stencil, TEX_W - 36);
  ctx.fillText(tag.title.toUpperCase(), TEX_W / 2, 164);
  ctx.fillStyle = ink;
  fitText(ctx, tag.detail, 700, 54, label, TEX_W - 36);
  ctx.fillText(tag.detail, TEX_W / 2, 284);
  ctx.fillRect(40, 330, TEX_W - 80, 5);
  distress(ctx, TEX_W, TEX_H, mulberry32(seed ^ SEED[tag.kind]), 0.3);
  return finish(canvas);
}

/** Sets the largest font up to `size` at which `text` fits in `width`. */
function fitText(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, family: string, width: number) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 20 && ctx.measureText(text).width > width) ctx.font = `${weight} ${(s -= 2)}px ${family}`;
}

interface Hung {
  spec: BoxTagSpec;
  side: 1 | -1;
  pivot: Group;
  face: Mesh;
  texture: CanvasTexture;
  phase: number;
}

/**
 * Paper tags tied to a box's front top corners, one per fact: hung from the body, so they rock
 * when it is shaken, and swaying a little on their own. `set` swaps them as the facts change.
 */
export class BoxTags {
  private readonly hung = new Map<BoxTagKind, Hung>();
  private readonly geometries = { face: new PlaneGeometry(TAG_W, TAG_H), string: new BoxGeometry(0.008, STRING, 0.008) };
  private readonly backTexture: CanvasTexture;
  private readonly back: MeshBasicMaterial;
  private readonly cord = new MeshBasicMaterial({ color: "#5A4630" });

  constructor(
    private readonly box: BoxObject,
    /** `scale` enlarges the tags, for boxes shown small (the shelf). */
    private readonly opts: TextureOptions & { reducedMotion?: boolean; scale?: number } = {},
  ) {
    this.backTexture = tagBackTexture(opts);
    this.back = new MeshBasicMaterial({ map: this.backTexture, alphaTest: 0.5, color: "#A89C80" });
  }

  set(tags: readonly BoxTagSpec[]): void {
    const sides = tagSides(tags);
    for (const [kind, h] of this.hung) {
      const next = tags.find((t) => t.kind === kind);
      if (next && next.title === h.spec.title && next.detail === h.spec.detail && sides.get(kind) === h.side) continue;
      this.drop(kind);
    }
    for (const tag of tags) {
      const side = sides.get(tag.kind);
      if (side && !this.hung.has(tag.kind)) this.hang(tag, side);
    }
  }

  update(time: number): void {
    if (this.opts.reducedMotion) return;
    for (const h of this.hung.values()) {
      h.pivot.rotation.z = Math.sin(time * 1.3 + h.phase) * 0.07;
      h.pivot.rotation.x = -0.12 + Math.sin(time * 0.9 + h.phase * 2) * 0.04;
    }
  }

  dispose(): void {
    for (const kind of [...this.hung.keys()]) this.drop(kind);
    this.geometries.face.dispose();
    this.geometries.string.dispose();
    this.back.dispose();
    this.backTexture.dispose();
    this.cord.dispose();
  }

  private hang(spec: BoxTagSpec, side: 1 | -1): void {
    const { width: W, height: H, depth: D } = BOX_SIZE;
    const pivot = new Group();
    // Right on the corner, so the tag hangs half off the box, clear of the shipping label, its
    // bottom tipped forward, off the cardboard. Both turn the same way, a little towards the
    // camera: tags of neighbours on a shelf pass one in front of the other.
    pivot.position.set(side * W / 2, H - 0.02, D / 2 + 0.03);
    pivot.rotation.set(-0.12, 0.18, 0);
    pivot.scale.setScalar(this.opts.scale ?? 1);

    const string = new Mesh(this.geometries.string, this.cord);
    string.position.y = -STRING / 2;
    pivot.add(string);

    const texture = tagTexture(spec, this.box.spec.noiseSeed, this.opts);
    const front = new MeshBasicMaterial({ map: texture, alphaTest: 0.5, color: "#D8CFBE" });
    const face = new Mesh(this.geometries.face, front);
    face.position.y = -STRING - TAG_H / 2 + 0.035;
    pivot.add(face);
    const back = new Mesh(this.geometries.face, this.back);
    back.rotation.y = Math.PI;
    back.position.z = -0.002;
    face.add(back);

    this.box.body.add(pivot);
    this.hung.set(spec.kind, { spec, side, pivot, face, texture, phase: side + this.box.spec.noiseSeed * 1e-6 });
  }

  private drop(kind: BoxTagKind): void {
    const h = this.hung.get(kind);
    if (!h) return;
    h.pivot.removeFromParent();
    h.texture.dispose();
    (h.face.material as MeshBasicMaterial).dispose();
    this.hung.delete(kind);
  }
}
