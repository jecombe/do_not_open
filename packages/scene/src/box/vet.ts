import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from "three";
import { mulberry32 } from "@dno/generator";
import { BOX_SIZE, type BoxObject } from "./buildBox";
import { distress, type TextureOptions } from "./textures";

const VET_GREEN = "#2F7D3A";
const VET_SLATE = "#56606B";

/** The vet's round rubber stamp: "VET · ALIVE · CERTIFIED", or "NO PULSE" in grey. */
export function vetStampTexture(alive: boolean, seed: number, opts: TextureOptions = {}): CanvasTexture {
  const size = 512;
  const canvas = opts.createCanvas?.(size, size) ?? Object.assign(document.createElement("canvas"), { width: size, height: size });
  const ctx = canvas.getContext("2d")! as CanvasRenderingContext2D;
  const ink = alive ? VET_GREEN : VET_SLATE;
  const font = opts.stencilFont ?? '"Stardos Stencil", "Arial Black", sans-serif';
  const c = size / 2;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 20;
  ctx.beginPath();
  ctx.arc(c, c, c - 18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(c, c, c - 52, 0, Math.PI * 2);
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 64px ${font}`;
  ctx.fillText("VET", c, c - 130);
  ctx.font = `700 ${alive ? 104 : 86}px ${font}`;
  ctx.fillText(alive ? "ALIVE" : "NO PULSE", c, c + 4, size - 130);
  ctx.font = `700 50px ${font}`;
  ctx.fillText(alive ? "CERTIFIED" : "CHECKED", c, c + 118);
  // A small cross between the rings, left and right.
  for (const x of [c - 170, c + 170]) {
    ctx.fillRect(x - 16, c - 5, 32, 10);
    ctx.fillRect(x - 5, c - 16, 10, 32);
  }
  distress(ctx, size, size, mulberry32(seed ^ 0x7e7), 0.45);
  const tex = new CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * The vet's mark on the front of a box, top right, where nothing else is printed. Shown
 * at once for a box certified some other day, or stamped: it comes down from in front
 * of the box and lands with a thud.
 */
export class VetMark {
  /** Fires once, when the stamp hits the cardboard. */
  onThud: (() => void) | null = null;

  private readonly mesh: Mesh;
  private time = -1;
  private fired = false;
  private readonly duration: number;
  private readonly rest = { x: 0.34, y: 0.68, z: BOX_SIZE.depth / 2 + 0.004 };

  constructor(
    private readonly box: BoxObject,
    readonly alive: boolean,
    opts: TextureOptions & { reducedMotion?: boolean } = {},
  ) {
    const tex = vetStampTexture(alive, box.spec.noiseSeed, opts);
    const mat = new MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
    this.mesh = new Mesh(new PlaneGeometry(0.34, 0.34), mat);
    this.mesh.rotation.z = -0.22 + box.spec.stampRotation * 0.5;
    this.mesh.visible = false;
    box.body.add(this.mesh);
    this.duration = opts.reducedMotion ? 0.12 : 0.45;
  }

  showInstant(): void {
    this.fired = true;
    this.time = this.duration;
    this.place(1);
  }

  stamp(): void {
    if (this.time >= 0) return;
    this.time = 0;
  }

  update(dt: number): void {
    if (this.time < 0 || this.time >= this.duration) return;
    this.time = Math.min(this.duration, this.time + dt);
    this.place(this.time / this.duration);
  }

  /** 0: held up in front of the box; 1: inked on it. The hit is at 70%, then the ink settles. */
  private place(k: number): void {
    const hit = Math.min(1, k / 0.7);
    const fall = hit * hit;
    const { x, y, z } = this.rest;
    this.mesh.visible = true;
    this.mesh.position.set(x, y, z + (1 - fall) * 0.35);
    this.mesh.scale.setScalar(1 + (1 - fall) * 0.5);
    const mat = this.mesh.material as MeshBasicMaterial;
    mat.opacity = k < 0.7 ? 0.25 + 0.5 * hit : 0.75 + 0.2 * ((k - 0.7) / 0.3);
    if (hit >= 1 && !this.fired) {
      this.fired = true;
      this.onThud?.();
    }
    // The box gives a little under the blow.
    const squash = k >= 0.7 ? Math.sin(((k - 0.7) / 0.3) * Math.PI) * 0.02 : 0;
    this.box.body.scale.set(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
  }

  dispose(): void {
    const mat = this.mesh.material as MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
    this.box.body.scale.set(1, 1, 1);
  }
}
