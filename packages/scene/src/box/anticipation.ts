import { AdditiveBlending, Mesh, MeshBasicMaterial, PlaneGeometry, PointLight, type Object3D } from "three";
import { mulberry32 } from "@dno/generator";
import { BOX_SIZE, type BoxObject } from "./buildBox";

/**
 * Where a slow chain action is: signing, waiting for a block, waiting for a decryption,
 * signing the proof. Mirrors the adapter's steps without depending on them.
 */
export type WaitStage = "wallet" | "confirming" | "decrypting" | "proving";

/**
 * "open" builds up to the lid opening; "peek" (a shake) only makes the cat restless;
 * "vet" (the alive check) is a heartbeat through the cardboard, whatever the answer.
 */
export type WaitKind = "open" | "peek" | "vet";

/** How far each stage pushes the box, and how restless the cat gets. */
const STAGES: Record<WaitStage, { lid: number; tape: number; glow: number; unrest: number }> = {
  wallet: { lid: 0, tape: 0, glow: 0, unrest: 0.15 },
  confirming: { lid: 0, tape: 0.35, glow: 0, unrest: 0.55 },
  decrypting: { lid: 0.1, tape: 0.6, glow: 0.55, unrest: 0.8 },
  proving: { lid: 0.2, tape: 0.8, glow: 1, unrest: 0.6 },
};
const REST = { lid: 0, tape: 0, glow: 0, unrest: 0 };
/** The glow is neutral on purpose: its colour must not hint at what is inside. */
const LEAK = "#FFE6C0";

const approach = (from: number, to: number, rate: number, dt: number) => to + (from - to) * Math.exp(-rate * dt);

/**
 * What a sealed box does while the chain is busy with it, so a long wait never looks
 * frozen: it breathes while the wallet asks, then the cat gets restless, the side tape
 * peels, the lid cracks and light leaks from the seam. On `release` everything settles
 * back shut, so the opening sequence starts from a closed box.
 *
 * It moves only what the shaker leaves alone: the outer group and the side strips of
 * tape, and, until released to the opener, the major flaps and the tape's height.
 */
export class BoxAnticipation {
  /** A thump from inside: strength 0 to 1. */
  onRattle: ((strength: number) => void) | null = null;
  /** The cat complains. */
  onMutter: (() => void) | null = null;
  /** One heartbeat, while the vet listens. */
  onBeat: (() => void) | null = null;

  private stage: WaitStage | null = null;
  private kind: WaitKind = "open";
  private now = { ...REST };
  private time = 0;
  private nextFidget = 1.5;
  private fidget = 0;
  private beatClock = 0;
  private releasing: { left: number; then: (() => void) | null } | null = null;
  /** Everything is back at rest and written once: stop touching the box, the opener may own it. */
  private settled = true;
  /** Released to the opening sequence: hands off the box until the next wait. */
  private handedOver = false;
  private readonly rand: () => number;
  private readonly light: PointLight;
  private readonly seam: Mesh;
  private readonly strips: Object3D[];

  constructor(
    private readonly box: BoxObject,
    private readonly reducedMotion = false,
  ) {
    const { width: W, height: H, wall: T } = BOX_SIZE;
    this.rand = mulberry32(box.spec.noiseSeed ^ 0xa771);
    this.light = new PointLight(LEAK, 0, 3, 1.8);
    this.light.position.set(0, H * 0.75, 0);
    box.body.add(this.light);

    const seamGeo = new PlaneGeometry(W * 0.96, 0.05);
    seamGeo.rotateX(-Math.PI / 2);
    this.seam = new Mesh(seamGeo, new MeshBasicMaterial({ color: LEAK, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    this.seam.position.set(0, H + T + 0.012, 0);
    this.seam.visible = false;
    box.body.add(this.seam);

    // The two strips running down the sides: they peel from the bottom up.
    this.strips = box.tape.children.filter((c) => Math.abs(c.position.x) > W / 4);
  }

  get active(): boolean {
    return !this.settled || this.stage !== null;
  }

  /** Follows the action. `null` when nothing is pending: the box settles by itself. */
  set(stage: WaitStage | null, kind: WaitKind = "open"): void {
    if (stage === this.stage && kind === this.kind) return;
    this.stage = stage;
    this.kind = kind;
    // A new wait takes the box back; settling never cancels a lid already slamming shut.
    if (stage) {
      this.handedOver = false;
      this.releasing = null;
    }
  }

  /** Slams the lid shut over `seconds`, then calls `then`: the opening takes over from there. */
  release(seconds: number, then: () => void): void {
    this.stage = null;
    this.releasing = { left: this.reducedMotion ? 0 : seconds, then };
  }

  update(dt: number): void {
    if (this.handedOver) return;
    const still = this.now.unrest < 0.01 && this.now.lid < 0.002 && this.now.glow < 0.01 && this.now.tape < 0.01;
    if (!this.stage && !this.releasing && still) {
      if (!this.settled) this.settle();
      return;
    }
    this.settled = false;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const want = this.stage ? STAGES[this.stage] : REST;
    const vet = this.kind === "vet";
    // A shake or a check never touches the lid; the vet also wants the cat calm.
    const goal = this.kind === "open" ? want : { ...want, lid: 0, tape: 0, glow: 0, unrest: vet ? want.unrest * 0.3 : want.unrest };

    // Releasing: everything drops back fast, the lid with a thump at the end.
    const rate = this.releasing ? 14 : 1.4;
    this.now.lid = approach(this.now.lid, goal.lid, this.releasing ? rate : 0.8, dt);
    this.now.tape = approach(this.now.tape, this.releasing ? this.now.tape : goal.tape, 0.5, dt);
    this.now.glow = approach(this.now.glow, goal.glow, this.releasing ? rate : 1.2, dt);
    this.now.unrest = approach(this.now.unrest, goal.unrest, rate, dt);

    const { group, flaps } = this.box;
    const calm = this.reducedMotion ? 0.2 : 1;

    // Breathing while someone decides in their wallet; fidgets once the chain has it.
    const breathe = this.stage === "wallet" ? Math.sin(this.time * 2.4) * 0.006 * calm : 0;
    this.nextFidget -= dt * this.now.unrest;
    if (this.stage && this.stage !== "wallet" && this.nextFidget <= 0) {
      this.fidget = 1;
      this.nextFidget = 1.2 + this.rand() * 2.6;
      this.onRattle?.(0.08 + this.rand() * 0.2 * this.now.unrest);
      if (this.rand() < 0.35) this.onMutter?.();
    }
    this.fidget = Math.max(0, this.fidget - dt * 3.2);
    const jolt = this.fidget * this.fidget * calm;
    // The vet listening: lub-dub, about seventy a minute, from the moment the chain has it.
    let beat = 0;
    if (vet && this.stage && this.stage !== "wallet") {
      const period = 0.86;
      const before = this.beatClock;
      this.beatClock = (this.beatClock + dt) % period;
      if (this.beatClock < before) this.onBeat?.();
      const lub = Math.exp(-(((this.beatClock - 0.04) / 0.05) ** 2));
      const dub = 0.6 * Math.exp(-(((this.beatClock - 0.26) / 0.05) ** 2));
      beat = (lub + dub) * 0.018 * calm;
    }
    group.scale.set(1 - breathe * 0.5 + beat * 0.6, 1 + breathe + beat, 1 - breathe * 0.5 + beat * 0.6);
    group.rotation.z = Math.sin(this.time * 38) * 0.02 * jolt;
    group.position.x = Math.sin(this.time * 51) * 0.012 * jolt;
    group.position.y = Math.abs(Math.sin(this.time * 24)) * 0.018 * jolt;

    // The side strips peel from the bottom, the lid cracks and breathes with the light.
    for (const s of this.strips) s.rotation.z = Math.sign(s.position.x) * this.now.tape * 0.5;
    const flutter = this.now.lid > 0.01 ? Math.sin(this.time * 3.1) * 0.025 * calm : 0;
    const lid = Math.max(0, this.now.lid + flutter * this.now.lid * 4);
    flaps.major[0].rotation.x = lid;
    flaps.major[1].rotation.x = -lid;
    // The tape across the lid rides up with the seam instead of vanishing under the flaps.
    this.box.tape.position.y = Math.sin(lid) * BOX_SIZE.depth * 0.5;

    const pulse = 0.75 + 0.25 * Math.sin(this.time * 2.2);
    this.seam.visible = this.now.glow > 0.01;
    (this.seam.material as MeshBasicMaterial).opacity = this.now.glow * 0.8 * pulse;
    this.light.intensity = this.now.glow * 3.5 * pulse;

    if (this.releasing) {
      this.releasing.left -= dt;
      if (this.releasing.left <= 0) {
        const then = this.releasing.then;
        this.releasing = null;
        this.settle();
        this.handedOver = true;
        this.onRattle?.(0.35);
        then?.();
      }
    }
  }

  /** Puts everything it moves back where it found it. */
  private settle(): void {
    this.settled = true;
    this.now = { ...REST, tape: this.now.tape };
    const { group, flaps } = this.box;
    group.scale.set(1, 1, 1);
    group.rotation.z = 0;
    group.position.set(0, 0, 0);
    flaps.major[0].rotation.x = 0;
    flaps.major[1].rotation.x = 0;
    this.box.tape.position.y = 0;
    this.seam.visible = false;
    this.light.intensity = 0;
  }

  dispose(): void {
    this.seam.geometry.dispose();
    (this.seam.material as MeshBasicMaterial).dispose();
    this.light.removeFromParent();
    this.seam.removeFromParent();
  }
}
