import { Group, Vector3 } from "three";
import { buildRatSpec } from "@dno/generator";
import { createRat, type RatObject } from "@dno/scene";
import { Stage } from "../docs/three/stage";
import { pageSound } from "./sound";

const randomSeed = () => {
  const w = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(w[0]!) << 32n) | BigInt(w[1]!);
};

/** How long a hop lasts, in seconds; the next rat takes over at its top. */
const HOP = 0.55;

/**
 * The home page's studio rat: one of the studio's free rats, sniffing about on the page. Click
 * it and it squeaks, hops, and comes down as another rat.
 */
export class RatToy {
  private readonly stage: Stage;
  private readonly holder = new Group();
  private rat: RatObject | null = null;
  private hopFrom = -1;
  private swapped = false;
  private now = 0;

  constructor(host: HTMLElement) {
    const stage = (this.stage = new Stage(host));
    stage.addGround(0.9, 0.9, 0);
    this.holder.rotation.y = -0.35;
    this.holder.userData.pick = "rat";
    stage.scene.add(this.holder);
    stage.pickables.push(this.holder);
    stage.onSelect = () => this.poke();
    stage.onLayout = () => stage.frame(new Vector3(0.12, 0.6, -0.1), 2.15, 1.6, new Vector3(0.35, 0.3, 1));
    stage.onLayout(1);
    stage.onFrame((time) => this.update(time));
    this.next();
  }

  /** A squeak and a hop; the rat that lands is another one. */
  poke(): void {
    pageSound.resume();
    pageSound.squeak();
    if (this.hopFrom >= 0) return;
    if (this.stage.reduced) return this.next();
    this.hopFrom = this.now;
    this.swapped = false;
    this.stage.wake();
  }

  dispose(): void {
    this.rat?.dispose();
    this.stage.dispose();
  }

  private next(): void {
    if (this.rat) {
      this.holder.remove(this.rat.group);
      this.rat.dispose();
    }
    this.rat = createRat(buildRatSpec(randomSeed()));
    this.holder.add(this.rat.group);
    this.stage.wake();
  }

  private update(time: number): void {
    this.now = time;
    if (this.hopFrom >= 0) {
      const t = (time - this.hopFrom) / HOP;
      if (t >= 0.5 && !this.swapped) {
        this.swapped = true;
        this.next();
      }
      if (t >= 1) {
        this.hopFrom = -1;
        this.holder.position.y = 0;
        this.holder.rotation.y = -0.35;
      } else {
        this.holder.position.y = Math.sin(Math.PI * t) * 0.45;
        this.holder.rotation.y = -0.35 + Math.sin(Math.PI * t) * Math.PI * 2 * t;
      }
    }
    this.rat?.update(time);
  }
}
