import { Group, SpotLight, Vector3 } from "three";
import { spec } from "@dno/game-spec";
import { buildBoxSpec, buildCatSpec, type CatSpec } from "@dno/generator";
import { BOX_SIZE, BoxOpener, BoxShaker, createBox, createCat, Unboxing, type BoxObject, type CatObject } from "@dno/scene";
import { PALETTE, Stage } from "../docs/three/stage";

/** Shakes it takes before the box gives in. */
export const SHAKES_TO_OPEN = 3;

const randomSeed = () => {
  const w = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(w[0]!) << 32n) | BigInt(w[1]!);
};
const randomToken = () => Math.floor(Math.random() * spec.collection.maxSupply);

interface Round {
  box: BoxObject;
  shaker: BoxShaker;
  opener: BoxOpener;
  unbox: Unboxing;
  cat: CatObject;
  spec: CatSpec;
  holder: Group;
  /** Height above the floor while the box drops in, and how fast it falls. */
  y: number;
  vy: number;
}

/**
 * The home page's toy: a box that drops onto the floor with a bounce. Click it and it
 * rattles; the third click is one too many and a random cat jumps out.
 */
export class PopBoxScene {
  onShake: ((count: number) => void) | null = null;
  onOpened: ((cat: CatSpec) => void) | null = null;

  private readonly stage: Stage;
  private readonly bubble: HTMLElement;
  private round: Round | null = null;
  private shakes = 0;
  private opening = false;
  private sayUntil = 0;
  private now = 0;

  constructor(host: HTMLElement) {
    const stage = (this.stage = new Stage(host));
    stage.addGround(1.5, 1.5, 0);
    const lamp = new SpotLight(PALETTE.sodium, 36, 9, 0.6, 0.7, 1.5);
    lamp.position.set(0.8, 4.2, 1.8);
    lamp.target.position.set(0, BOX_SIZE.height / 2, 0);
    stage.scene.add(lamp, lamp.target);

    this.bubble = stage.addLabel("pop-bubble", new Vector3(0.1, BOX_SIZE.height + 0.75, 0));
    stage.onSelect = () => this.poke();
    stage.onLayout = () => stage.frame(new Vector3(0, BOX_SIZE.height * 0.7, 0), 2.7, 2.6, new Vector3(0.45, 0.5, 1));
    stage.onLayout(1);
    stage.onFrame((time, dt) => this.update(time, dt));
    this.next();
  }

  /** A shake, or the last straw. */
  poke(): void {
    const r = this.round;
    if (!r || this.opening || r.y > 0.01) return;
    this.shakes++;
    this.onShake?.(this.shakes);
    if (this.shakes >= SHAKES_TO_OPEN) {
      this.opening = true;
      r.opener.open();
    } else {
      r.shaker.shake({ strength: 0.7 + this.shakes * 0.25, duration: 1.1 });
    }
    this.stage.wake();
  }

  /** Clears the floor and drops a fresh box. */
  next(): void {
    this.clear();
    const box = createBox(buildBoxSpec(randomToken()));
    box.group.rotation.y = -0.45;
    box.group.userData.pick = "box";
    const spec = buildCatSpec({ seed: randomSeed() });
    const cat = createCat(spec);
    const holder = new Group();
    holder.add(cat.group);
    const reduced = this.stage.reduced;
    const opener = new BoxOpener(box, { content: holder, glow: spec.state === "ghost" || spec.state === "quantum" ? PALETTE.spectral : spec.room.light, reducedMotion: reduced });
    const unbox = new Unboxing(box, holder, { reducedMotion: reduced, lamp: true });
    opener.onDone = () => unbox.start();
    unbox.onLand = () => this.onOpened?.(spec);
    this.stage.scene.add(box.group);
    this.stage.pickables.push(box.group, holder);
    holder.userData.pick = "cat";
    this.round = { box, shaker: new BoxShaker(box, { reducedMotion: reduced }), opener, unbox, cat, spec, holder, y: reduced ? 0 : 3, vy: 0 };
    this.shakes = 0;
    this.opening = false;
    this.stage.wake();
  }

  /** Puts words in the box's mouth for a moment. */
  say(text: string | null, seconds = 1.6): void {
    this.bubble.textContent = text ?? "";
    this.bubble.classList.toggle("on", !!text);
    this.sayUntil = this.now + seconds;
  }

  dispose(): void {
    this.clear();
    this.stage.dispose();
  }

  private clear(): void {
    const r = this.round;
    if (!r) return;
    r.unbox.dispose();
    r.holder.removeFromParent();
    r.opener.dispose();
    r.cat.dispose();
    r.box.group.removeFromParent();
    r.box.dispose();
    this.stage.pickables.length = 0;
    this.round = null;
  }

  private update(time: number, dt: number): void {
    this.now = time;
    if (this.bubble.classList.contains("on") && time > this.sayUntil) this.bubble.classList.remove("on");
    const r = this.round;
    if (!r) return;

    // Falls in, bounces twice, settles.
    if (r.y > 0 || r.vy !== 0) {
      r.vy -= 16 * dt;
      r.y += r.vy * dt;
      if (r.y <= 0) {
        r.y = 0;
        r.vy = Math.abs(r.vy) > 1.5 ? -r.vy * 0.38 : 0;
      }
      r.box.group.position.y = r.y;
    } else if (!this.opening && !this.stage.reduced) {
      // Sealed and waiting: it fidgets, as if something inside wanted out.
      r.box.group.rotation.y = -0.45 + Math.sin(time * 0.7) * 0.18;
    }

    r.shaker.update(dt);
    r.opener.update(dt);
    r.unbox.update(dt);
    r.cat.update(time);
  }
}
