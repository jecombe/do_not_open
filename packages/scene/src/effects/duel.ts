import { Group, PointLight, SpotLight } from "three";
import { BOX_SIZE, type BoxObject } from "../box/buildBox";
import { BoxShaker } from "../box/shaker";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const span = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
const easeInCubic = (x: number) => x ** 3;
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;

export interface DuelArenaOptions {
  /** Half the distance between the two boxes at rest. */
  spread?: number;
  reducedMotion?: boolean;
}

/**
 * The duel: two boxes under two spotlights. They rattle, lunge, collide in a flash, and
 * the loser is knocked back on its heels in the dark while the winner hops in the light.
 * Nothing about either box is revealed by the animation itself; the bit comes from chain.
 */
export class DuelArena {
  readonly group = new Group();
  onImpact: ((strength: number) => void) | null = null;
  onClash: (() => void) | null = null;
  onDone: (() => void) | null = null;

  private readonly spots: [SpotLight, SpotLight];
  private readonly flash: PointLight;
  private readonly shakers: [BoxShaker, BoxShaker];
  private readonly spread: number;
  private readonly reducedMotion: boolean;
  private time = -1;
  private aWins = true;
  private clashed = false;
  private finished = false;

  constructor(
    private readonly boxA: BoxObject,
    private readonly boxB: BoxObject,
    opts: DuelArenaOptions = {},
  ) {
    this.spread = opts.spread ?? 0.78;
    this.reducedMotion = opts.reducedMotion ?? false;
    boxA.group.position.x = -this.spread;
    boxB.group.position.x = this.spread;
    this.group.add(boxA.group, boxB.group);

    const spot = (x: number, color: string) => {
      const s = new SpotLight(color, 0, 8, 0.38, 0.7, 1.4);
      s.position.set(x * 1.4, 3.4, 1.6);
      s.target.position.set(x, BOX_SIZE.height * 0.5, 0);
      this.group.add(s, s.target);
      return s;
    };
    this.spots = [spot(-this.spread, "#FFD7A0"), spot(this.spread, "#A9C8FF")];
    this.flash = new PointLight("#FFFFFF", 0, 5, 1.5);
    this.flash.position.set(0, BOX_SIZE.height * 0.7, 0.4);
    this.group.add(this.flash);

    this.shakers = [new BoxShaker(boxA, { reducedMotion: this.reducedMotion }), new BoxShaker(boxB, { reducedMotion: this.reducedMotion })];
    for (const s of this.shakers) s.onImpact = (strength) => this.onImpact?.(strength);
  }

  get active(): boolean {
    return this.time >= 0 && !this.finished;
  }

  /** Lights up the arena without starting a fight. */
  setSpotlights(on: boolean): void {
    for (const s of this.spots) s.intensity = on ? 26 : 0;
  }

  /** Plays the duel towards a known outcome. */
  play(aWins: boolean): void {
    this.reset();
    this.aWins = aWins;
    this.time = 0;
    for (const s of this.shakers) s.shake({ strength: 0.8, duration: 1.2 });
  }

  /** Puts both boxes back on their marks, upright and evenly lit. */
  reset(): void {
    this.time = -1;
    this.clashed = false;
    this.finished = false;
    for (const [box, side] of [[this.boxA, -1], [this.boxB, 1]] as const) {
      box.group.position.set(side * this.spread, 0, 0);
      box.group.rotation.set(0, 0, 0);
    }
    this.setSpotlights(true);
    this.flash.intensity = 0;
  }

  update(dt: number): void {
    for (const s of this.shakers) s.update(dt);
    if (this.time < 0 || this.finished) return;
    this.time += Math.min(dt, 0.1);
    const t = this.time;
    const reach = this.spread - BOX_SIZE.width / 2 - 0.01;
    const winner = this.aWins ? this.boxA : this.boxB;
    const loser = this.aWins ? this.boxB : this.boxA;
    const winSide = this.aWins ? -1 : 1;
    const amp = this.reducedMotion ? 0.3 : 1;

    // 1.2 - 1.55  wind up and lunge
    const lunge = easeInCubic(span(t, 1.2, 1.55));
    // 1.55 - 2.3  recoil
    const recoil = easeOutCubic(span(t, 1.55, 2.3));
    const closing = reach * lunge * amp;

    winner.group.position.x = winSide * (this.spread - closing * (1 - recoil));
    loser.group.position.x = -winSide * (this.spread - closing + recoil * (closing + 0.22 * amp));
    // The loser rocks back and stays leaning, like a box that lost an argument.
    loser.group.rotation.z = winSide * -0.2 * amp * recoil * (1 - 0.35 * span(t, 2.3, 3.0));

    if (t >= 1.55 && !this.clashed) {
      this.clashed = true;
      this.onClash?.();
    }
    this.flash.intensity = this.clashed ? 60 * (1 - span(t, 1.55, 1.9)) ** 2 : 0;

    // 2.0 - 3.4  verdict: one light dies, the winner hops twice
    const verdict = span(t, 2.0, 2.6);
    this.spots[this.aWins ? 0 : 1].intensity = 26 + 18 * verdict;
    this.spots[this.aWins ? 1 : 0].intensity = 26 * (1 - 0.88 * verdict);
    const hop = span(t, 2.3, 3.3);
    winner.group.position.y = Math.abs(Math.sin(hop * Math.PI * 2)) * 0.14 * amp * (1 - hop * 0.4);

    if (t >= 3.4) {
      this.finished = true;
      winner.group.position.y = 0;
      this.onDone?.();
    }
  }

  dispose(): void {
    this.group.remove(this.boxA.group, this.boxB.group);
    for (const s of this.spots) s.dispose();
    this.flash.dispose();
  }
}
