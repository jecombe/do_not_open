import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PointLight,
  Points,
  PointsMaterial,
  Vector3,
} from "three";
import { mulberry32 } from "@dno/generator";
import { BOX_SIZE, type BoxObject } from "./buildBox";

export interface OpenOptions {
  /** What is inside. It rises out of the box once the flaps are open. */
  content?: Object3D;
  /** Colour of the light that comes out. */
  glow?: string;
  reducedMotion?: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const span = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;

/** How the content sits once the box is open: its floor this high up the box, this big, leaning back this much. */
const REST_FLOOR = BOX_SIZE.wall + 0.02 + BOX_SIZE.height * 0.55;
const REST_SCALE = 0.9;
const REST_TILT = -0.32;
/** Clearance kept between the content and the inside of the walls. */
const WALL_MARGIN = 0.04;
/** Never shrink the content below this, whatever its shape. */
const MIN_FIT_SCALE = 0.45;

interface Fit {
  scale: number;
  x: number;
  z: number;
}

/**
 * Finds the scale and centring that keep whatever part of `content` ends up below the
 * rim inside the walls. Cats come in every pose: a curled tail or a crouching cat's front
 * paws otherwise stick out through the cardboard. Anything above the rim may overhang,
 * that is the point of an open box. Works from the meshes' current vertices, so the tail
 * must already be bent when this runs; `content`'s own transform is ignored.
 */
function fitInBox(content: Object3D): Fit {
  const { width: W, depth: D, height: H, wall: T } = BOX_SIZE;
  const hx = W / 2 - T - WALL_MARGIN;
  const hz = D / 2 - T - WALL_MARGIN;
  const rim = H - REST_FLOOR;

  content.updateWorldMatrix(true, true);
  const toContent = new Matrix4().copy(content.matrixWorld).invert();
  const tilt = new Matrix4().makeRotationX(REST_TILT);
  const m = new Matrix4();
  const v = new Vector3();
  const pts: number[] = [];
  content.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    // Outlines are copies of their parent mesh, slightly inflated: skip them.
    const parent = mesh.parent as Mesh | null;
    if (parent?.isMesh && parent.geometry === mesh.geometry) return;
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) return;
    m.multiplyMatrices(toContent, mesh.matrixWorld).premultiply(tilt);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      pts.push(v.x, v.y, v.z);
    }
  });

  const fit: Fit = { scale: REST_SCALE, x: 0, z: 0 };
  if (!pts.length) return fit;
  // Shrinking brings more of the content under the rim, so search downwards in small steps.
  for (let s = REST_SCALE; ; s = Math.max(MIN_FIT_SCALE, s - 0.02)) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      if (pts[i + 1]! * s >= rim) continue;
      const x = pts[i]!, z = pts[i + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (minX === Infinity) break;
    const fits = ((maxX - minX) / 2) * s <= hx && ((maxZ - minZ) / 2) * s <= hz;
    if (fits || s <= MIN_FIT_SCALE) {
      fit.scale = s;
      fit.x = (-(minX + maxX) / 2) * s;
      fit.z = (-(minZ + maxZ) / 2) * s;
      break;
    }
  }
  return fit;
}

/**
 * The observe sequence: the box trembles, tape and stamp rip off, the four flaps swing
 * open, light and dust burst out, and the content rises into view. Irreversible, like
 * the transaction it stands for.
 */
export class BoxOpener {
  /** Fires once when the tape starts to tear. */
  onRip: (() => void) | null = null;
  /** Fires once when the lid bursts open. */
  onBurst: (() => void) | null = null;
  onDone: (() => void) | null = null;

  private time = -1;
  private silent = false;
  private fired = { rip: false, burst: false, done: false };
  private readonly duration: number;
  private readonly light: PointLight;
  private readonly beam: Mesh;
  private readonly dust: Points;
  private readonly velocities: Float32Array;
  private readonly tapeMaterials: Material[] = [];
  private readonly content: Object3D | null;
  private readonly rand: () => number;
  private fit: Fit = { scale: REST_SCALE, x: 0, z: 0 };
  /** Mesh counts of the content: as last seen, and as last measured. It fills in when its assets load. */
  private meshes = { seen: 0, measured: 0 };
  private rise = 0;

  constructor(private readonly box: BoxObject, opts: OpenOptions = {}) {
    const { width: W, height: H, depth: D } = BOX_SIZE;
    const glow = opts.glow ?? "#FFE2B0";
    this.rand = mulberry32(box.spec.noiseSeed ^ 0x0be4);
    this.duration = opts.reducedMotion ? 1.2 : 3.4;
    this.content = opts.content ?? null;

    this.light = new PointLight(glow, 0, 6, 1.6);
    this.light.position.set(0, H * 0.6, 0);
    box.body.add(this.light);

    const beamGeo = new ConeGeometry(0.9, 2.6, 24, 1, true);
    beamGeo.translate(0, -1.3, 0);
    beamGeo.rotateX(Math.PI);
    const beamMat = new MeshBasicMaterial({ color: glow, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: 2 });
    this.beam = new Mesh(beamGeo, beamMat);
    this.beam.position.y = H * 0.7;
    this.beam.scale.set(W * 0.5, 1, D * 0.5);
    this.beam.visible = false;
    box.body.add(this.beam);

    const count = opts.reducedMotion ? 0 : 160;
    const positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const c = new Color();
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (this.rand() - 0.5) * W * 0.7;
      positions[i * 3 + 1] = H * 0.8;
      positions[i * 3 + 2] = (this.rand() - 0.5) * D * 0.7;
      const a = this.rand() * Math.PI * 2;
      const out = 0.4 + this.rand() * 1.4;
      this.velocities[i * 3] = Math.cos(a) * out;
      this.velocities[i * 3 + 1] = 2.2 + this.rand() * 2.6;
      this.velocities[i * 3 + 2] = Math.sin(a) * out;
      // Mostly cardboard dust, a few motes in the glow colour.
      c.set(this.rand() < 0.3 ? glow : "#C9A06C").toArray(colors, i * 3);
    }
    const dustGeo = new BufferGeometry();
    dustGeo.setAttribute("position", new BufferAttribute(positions, 3));
    dustGeo.setAttribute("color", new BufferAttribute(colors, 3));
    this.dust = new Points(
      dustGeo,
      new PointsMaterial({ size: 0.045, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true }),
    );
    this.dust.frustumCulled = false;
    this.dust.visible = false;
    box.body.add(this.dust);

    box.tape.traverse((o) => {
      const m = (o as Mesh).material as Material | undefined;
      if (m && !this.tapeMaterials.includes(m)) this.tapeMaterials.push(m);
    });

    if (this.content) {
      this.content.visible = false;
      box.body.add(this.content);
    }
  }

  get active(): boolean {
    return this.time >= 0 && this.time < this.duration;
  }

  get opened(): boolean {
    return this.time >= this.duration;
  }

  open(): void {
    if (this.time >= 0) return;
    this.time = 0;
  }

  /**
   * Jumps straight to the opened state, with no sequence, no sound and no callback:
   * for a box that was opened some other day.
   */
  openInstant(): void {
    if (this.time >= 0) return;
    this.fired.rip = true;
    this.fired.burst = true;
    this.silent = true;
    this.time = this.duration;
    this.update(0);
  }

  /**
   * Re-measures the content when it has changed since the last time (its assets arriving,
   * mostly), one frame late so that it has animated once and its tail is bent. Returns
   * true when the fit changed.
   */
  private refit(): boolean {
    if (!this.content) return false;
    let count = 0;
    this.content.traverse((o) => {
      if ((o as Mesh).isMesh) count++;
    });
    const settled = count === this.meshes.seen;
    this.meshes.seen = count;
    if (!settled || count === this.meshes.measured || count === 0) return false;
    this.meshes.measured = count;
    this.fit = fitInBox(this.content);
    return true;
  }

  /** Puts the content where the sequence wants it at this point of its rise (0 to 1). */
  private placeContent(rise: number): void {
    if (!this.content) return;
    this.rise = rise;
    const e = easeOutBack(rise);
    const k = easeOutCubic(rise);
    const { scale, x, z } = this.fit;
    this.content.visible = rise > 0;
    this.content.position.set(x * k, BOX_SIZE.wall + 0.02 + e * (REST_FLOOR - BOX_SIZE.wall - 0.02), z * k);
    this.content.scale.setScalar(scale * (0.39 + 0.61 * k));
    // It looks up at whoever opened the box.
    this.content.rotation.x = REST_TILT * k;
  }

  update(dt: number): void {
    if (this.time < 0) return;
    if (this.fired.done) {
      // Opened already: only follow the content's shape as its assets arrive, and only
      // while it is still ours (the inspector may have taken it out onto the bench).
      if (this.refit() && this.content?.parent === this.box.body) this.placeContent(this.rise);
      return;
    }
    this.refit();
    this.time = Math.min(this.duration, this.time + dt);
    // Normalised so the reduced-motion version plays the same beats, faster.
    const t = (this.time / this.duration) * 3.4;
    const { body, flaps, tape, interior } = this.box;
    const { height: H, wall: T } = BOX_SIZE;

    // 0.0 - 0.7  tremble, building up
    const tremble = span(t, 0, 0.7) * (1 - span(t, 0.7, 0.9));
    body.rotation.z = Math.sin(t * 70) * 0.012 * tremble;
    body.position.x = Math.sin(t * 93) * 0.008 * tremble;

    // 0.35 - 1.0  tape and stamp rip off
    const rip = span(t, 0.35, 1.0);
    if (rip > 0 && !this.fired.rip) {
      this.fired.rip = true;
      this.onRip?.();
    }
    const ripE = easeOutCubic(rip);
    tape.position.set(ripE * 0.5, ripE * 0.9, -ripE * 0.35);
    tape.rotation.set(ripE * 0.7, 0, ripE * 0.9);
    for (const m of this.tapeMaterials) {
      m.transparent = true;
      m.opacity = 0.93 * (1 - span(t, 0.6, 1.0));
    }
    tape.visible = rip < 1;

    // 0.7 - 1.6  flaps swing open, majors first
    const major = easeOutBack(span(t, 0.7, 1.35)) * 2.6;
    const minor = easeOutBack(span(t, 0.9, 1.6)) * 2.3;
    flaps.major[0].rotation.x = major;
    flaps.major[1].rotation.x = -major;
    flaps.minor[0].rotation.z = minor;
    flaps.minor[1].rotation.z = -minor;
    if (span(t, 0.7, 1.35) > 0) interior.position.y = T + 0.003;

    // 0.8  burst
    const burst = span(t, 0.8, 0.95);
    if (burst > 0 && !this.fired.burst) {
      this.fired.burst = true;
      this.beam.visible = true;
      this.dust.visible = true;
      this.onBurst?.();
    }
    const fade = 1 - span(t, 1.0, 3.0);
    this.light.intensity = burst * (4 + 22 * fade ** 2);
    (this.beam.material as MeshBasicMaterial).opacity = burst * 0.32 * fade;
    this.beam.scale.y = 0.6 + easeOutCubic(span(t, 0.8, 1.6)) * 0.6;

    if (this.dust.visible) {
      const pos = this.dust.geometry.getAttribute("position") as BufferAttribute;
      const arr = pos.array as Float32Array;
      const step = Math.min(dt, 0.05);
      for (let i = 0; i < arr.length; i += 3) {
        this.velocities[i + 1]! -= 5.5 * step;
        arr[i]! += this.velocities[i]! * step;
        arr[i + 1]! += this.velocities[i + 1]! * step;
        arr[i + 2]! += this.velocities[i + 2]! * step;
      }
      pos.needsUpdate = true;
      (this.dust.material as PointsMaterial).opacity = (1 - span(t, 1.8, 3.0)) * 0.9;
    }

    // 1.3 - 2.6  the content rises until it is sitting in the box, head over the rim
    this.placeContent(span(t, 1.3, 2.6));

    if (this.time >= this.duration && !this.fired.done) {
      this.fired.done = true;
      body.rotation.z = 0;
      body.position.x = 0;
      this.beam.visible = false;
      this.dust.visible = false;
      this.light.intensity = 3;
      if (!this.silent) this.onDone?.();
    }
  }

  dispose(): void {
    this.beam.geometry.dispose();
    (this.beam.material as Material).dispose();
    this.dust.geometry.dispose();
    (this.dust.material as Material).dispose();
  }
}
