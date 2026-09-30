import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PointLight,
  Points,
  PointsMaterial,
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
  private fired = { rip: false, burst: false, done: false };
  private readonly duration: number;
  private readonly light: PointLight;
  private readonly beam: Mesh;
  private readonly dust: Points;
  private readonly velocities: Float32Array;
  private readonly tapeMaterials: Material[] = [];
  private readonly content: Object3D | null;
  private readonly rand: () => number;

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

  update(dt: number): void {
    if (this.time < 0 || this.fired.done) return;
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
    if (this.content) {
      const rise = span(t, 1.3, 2.6);
      this.content.visible = rise > 0;
      const e = easeOutBack(rise);
      this.content.position.y = T + 0.02 + e * (H * 0.55);
      this.content.scale.setScalar(0.35 + 0.55 * easeOutCubic(rise));
      // It looks up at whoever opened the box.
      this.content.rotation.x = -0.32 * easeOutCubic(rise);
    }

    if (this.time >= this.duration && !this.fired.done) {
      this.fired.done = true;
      body.rotation.z = 0;
      body.position.x = 0;
      this.beam.visible = false;
      this.dust.visible = false;
      this.light.intensity = 3;
      this.onDone?.();
    }
  }

  dispose(): void {
    this.beam.geometry.dispose();
    (this.beam.material as Material).dispose();
    this.dust.geometry.dispose();
    (this.dust.material as Material).dispose();
  }
}
