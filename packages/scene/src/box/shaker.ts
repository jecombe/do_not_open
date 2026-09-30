import { mulberry32 } from "@dno/generator";
import type { BoxObject } from "./buildBox";

export interface ShakeOptions {
  /** 0..1.5. Scales amplitude, not duration. */
  strength?: number;
  /** Seconds. */
  duration?: number;
}

/**
 * Rocks a box around its bottom centre with a decaying, slightly irregular wobble.
 * Fires `onImpact` each time the box slams from one side to the other, which is
 * where the sound layer hooks in.
 */
export class BoxShaker {
  onImpact: ((strength: number) => void) | null = null;
  onDone: (() => void) | null = null;

  private elapsed = 0;
  private duration = 0;
  private strength = 0;
  private lastSign = 0;
  private phases = [0, 0, 0];
  private freqs = [7, 5.3, 9.1];
  private readonly rand: () => number;
  private readonly reducedMotion: boolean;

  constructor(private readonly box: BoxObject, opts: { reducedMotion?: boolean } = {}) {
    this.rand = mulberry32(box.spec.noiseSeed ^ 0x5ac3);
    this.reducedMotion = opts.reducedMotion ?? false;
  }

  get active(): boolean {
    return this.elapsed < this.duration;
  }

  shake({ strength = 1, duration = 1.5 }: ShakeOptions = {}): void {
    this.elapsed = 0;
    this.duration = duration;
    this.strength = strength * (this.reducedMotion ? 0.25 : 1);
    this.lastSign = 0;
    this.phases = [this.rand() * 6.28, this.rand() * 6.28, this.rand() * 6.28];
    this.freqs = [6.2 + this.rand() * 1.6, 4.6 + this.rand() * 1.4, 8.4 + this.rand() * 1.8];
  }

  update(dt: number): void {
    const { body, flaps } = this.box;
    if (!this.active) return;
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const p = this.elapsed / this.duration;
    // Fast attack, long decay.
    const env = Math.min(1, p / 0.06) * (1 - p) ** 1.8 * this.strength;
    const t = this.elapsed * Math.PI * 2;
    const roll = Math.sin(t * this.freqs[0]! + this.phases[0]!);
    const pitch = Math.sin(t * this.freqs[1]! + this.phases[1]!);
    const hop = Math.abs(Math.sin(t * this.freqs[2]! * 0.5 + this.phases[2]!));

    body.rotation.z = roll * 0.13 * env;
    body.rotation.x = pitch * 0.07 * env;
    body.rotation.y = Math.sin(t * 1.7) * 0.05 * env;
    body.position.x = roll * -0.035 * env;
    body.position.y = hop * 0.07 * env;
    // Something inside pushes the lid on every hop.
    flaps.major[0].rotation.x = hop * 0.09 * env;
    flaps.major[1].rotation.x = -hop * 0.09 * env;

    const sign = Math.sign(roll);
    if (sign !== 0 && sign !== this.lastSign) {
      if (this.lastSign !== 0 && env > 0.04) this.onImpact?.(Math.min(1, env));
      this.lastSign = sign;
    }

    if (!this.active) {
      body.rotation.set(0, 0, 0);
      body.position.set(0, 0, 0);
      flaps.major[0].rotation.x = 0;
      flaps.major[1].rotation.x = 0;
      this.onDone?.();
    }
  }
}
