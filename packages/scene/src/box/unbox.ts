import { Object3D, PointLight, Quaternion, Vector3 } from "three";
import type { BoxObject } from "./buildBox";

export interface UnboxOptions {
  reducedMotion?: boolean;
  /** A warm lamp over the cat once it is out: worth it for one cat, not for a shelf of them. */
  lamp?: boolean;
}

const DURATION = 1.35;
/** How high the cat jumps on its way out, in its parent's units. */
const HOP = 0.85;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;

/**
 * Once a box is open, the cat jumps out and the box is done with: the jump crushes the
 * cardboard flat, the flattened box slides away and is gone, and the cat lands where the
 * box stood. A box opened some other day is shown straight away as the cat alone.
 *
 * `content` must be resting in the box (the opening sequence is over).
 */
export class Unboxing {
  /** The cardboard gives under the jump. */
  onCrush: (() => void) | null = null;
  /** The cat touches down on the bench. */
  onLand: (() => void) | null = null;

  private time = -1;
  private instant = false;
  private fired = { crush: false, land: false };
  private readonly duration: number;
  private readonly from = { position: new Vector3(), quaternion: new Quaternion(), scale: 1 };
  private readonly to = { position: new Vector3(), quaternion: new Quaternion() };
  private readonly boxHome = new Vector3();
  private lamp: PointLight | null = null;

  constructor(
    private readonly box: BoxObject,
    private readonly content: Object3D,
    private readonly opts: UnboxOptions = {},
  ) {
    this.duration = opts.reducedMotion ? 0.001 : DURATION;
  }

  /** True once the box is gone and the cat is out. */
  get done(): boolean {
    return this.time >= this.duration;
  }

  /** Starts the jump. */
  start(): void {
    if (this.time >= 0) return;
    this.time = 0;
  }

  /** The cat already out, no box: for a box opened some other day. Silent. */
  finishInstant(): void {
    this.instant = true;
    this.fired = { crush: true, land: true };
    if (this.time < 0) this.time = 0;
  }

  /** Where to aim a camera: just above the cat, in the box's parent's space. */
  focus(into = new Vector3()): Vector3 {
    return into.copy(this.boxHome).setY(this.boxHome.y + 0.56);
  }

  update(dt: number): void {
    if (this.time < 0) return;
    const parent = this.box.group.parent;
    // Not in the scene yet (a shelf mounts its boxes after building them): wait for it.
    if (!parent) return;
    if (this.content.parent !== parent) this.takeOut(parent);
    if (this.instant) this.time = this.duration;
    if (this.time > this.duration) return;

    this.time = Math.min(this.duration, this.time + dt);
    const p = this.time / this.duration;

    // 0 - 0.3: crushed flat by the jump. 0.45 - 0.8: the flat box slides back and is gone.
    const crush = easeOut(clamp01(p / 0.3));
    const away = easeInOut(clamp01((p - 0.45) / 0.35));
    const g = this.box.group;
    const shrink = 1 - away;
    g.scale.set((1 + 0.14 * crush) * shrink, Math.max(0.001, (1 - 0.94 * crush) * shrink), (1 + 0.14 * crush) * shrink);
    g.position.copy(this.boxHome);
    g.position.z -= away * 0.5;
    g.visible = p < 0.8;
    if (crush > 0.1 && !this.fired.crush) {
      this.fired.crush = true;
      this.onCrush?.();
    }

    // 0.05 - 0.9: the cat's jump, from its seat in the box to the bench where the box was.
    const j = clamp01((p - 0.05) / 0.85);
    const e = easeInOut(j);
    const c = this.content;
    c.position.lerpVectors(this.from.position, this.to.position, e);
    c.position.y += Math.sin(Math.PI * j) * HOP;
    c.quaternion.slerpQuaternions(this.from.quaternion, this.to.quaternion, e);
    c.scale.setScalar(this.from.scale + (1 - this.from.scale) * e);
    if (this.lamp) this.lamp.intensity = 2.6 * e;
    if (j >= 1 && !this.fired.land) {
      this.fired.land = true;
      this.onLand?.();
    }
    if (this.time >= this.duration) {
      g.visible = false;
      g.scale.setScalar(1);
      g.position.copy(this.boxHome);
    }
  }

  /** Moves the cat from the box to the bench without moving it on screen. */
  private takeOut(parent: Object3D): void {
    const g = this.box.group;
    this.boxHome.copy(g.position);
    parent.attach(this.content);
    this.from.position.copy(this.content.position);
    this.from.quaternion.copy(this.content.quaternion);
    this.from.scale = this.content.scale.x;
    // Standing where the box stood, facing the way its label faced.
    this.to.position.copy(g.position);
    this.to.quaternion.copy(g.quaternion);
    if (this.opts.lamp) {
      this.lamp = new PointLight("#FFF1DC", 0, 5, 1.4);
      this.lamp.position.set(g.position.x + 0.6, g.position.y + 1.7, g.position.z + 1.6);
      parent.add(this.lamp);
    }
  }

  dispose(): void {
    this.lamp?.removeFromParent();
    this.lamp?.dispose();
    const g = this.box.group;
    g.visible = true;
    g.scale.setScalar(1);
  }
}
