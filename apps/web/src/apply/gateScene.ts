import { BoxGeometry, CanvasTexture, Group, Mesh, MeshStandardMaterial, RepeatWrapping, Vector3 } from "three";
import { spec } from "@dno/game-spec";
import { buildBoxSpec, buildCatSpec, buildRatSpec, type CatSpec } from "@dno/generator";
import { BOX_SIZE, createBox, createCat, createRat, type BoxObject, type CatObject, type RatObject } from "@dno/scene";
import { PALETTE, Stage } from "../docs/three/stage";
import { catVoice, pageSound } from "../home/sound";

const randomSeed = () => {
  const w = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(w[0]!) << 32n) | BigInt(w[1]!);
};
const randomToken = () => Math.floor(Math.random() * spec.collection.maxSupply);

/** The baggage belt: how long, how fast, how many boxes ride it, and how small they are. */
const BELT = { length: 7.2, depth: 1.1, height: 0.22, speed: 0.55, boxes: 6, scale: 0.55, z: -1.15 } as const;
/** How long a hop lasts, in seconds. */
const HOP = 0.6;

interface Rider {
  box: BoxObject;
  x: number;
}

/** A dark rubber belt with yellow chevrons that slide along, drawn once on a canvas. */
function beltTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = PALETTE.ink;
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = "#FFD66B";
  g.lineWidth = 10;
  for (let x = -32; x < 288; x += 64) {
    g.beginPath();
    g.moveTo(x, 8);
    g.lineTo(x + 22, 32);
    g.lineTo(x, 56);
    g.stroke();
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = RepeatWrapping;
  tex.repeat.set(BELT.length / 1.2, 1);
  return tex;
}

/**
 * The boarding page's gate: sealed boxes ride a baggage belt behind the check-in desk, a cat
 * sits on its own box at the desk and talks in a bubble, and a rat works the tarmac beside it.
 * Click the cat for its voice and another cat; click the rat and it hops.
 */
export class GateScene {
  private readonly stage: Stage;
  private readonly bubble: HTMLElement;
  private readonly belt: Mesh;
  private readonly beltTex: CanvasTexture;
  private readonly riders: Rider[] = [];
  private readonly desk: BoxObject;
  private readonly catHolder = new Group();
  private readonly ratHolder = new Group();
  private cat: CatObject | null = null;
  private catSpec: CatSpec | null = null;
  private rat: RatObject | null = null;
  private catHop = -1;
  private ratHop = -1;
  private swapped = false;
  private now = 0;
  private sayUntil = Infinity;

  constructor(host: HTMLElement) {
    const stage = (this.stage = new Stage(host));
    stage.addGround(2.6, 1.6, 0);

    // The belt, and its boxes spaced along it.
    this.beltTex = beltTexture();
    this.belt = new Mesh(new BoxGeometry(BELT.length, BELT.height, BELT.depth), [
      new MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.6 }),
      new MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.6 }),
      new MeshStandardMaterial({ map: this.beltTex, roughness: 0.85 }),
      new MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.6 }),
      new MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.6 }),
      new MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.6 }),
    ]);
    this.belt.position.set(0, BELT.height / 2, BELT.z);
    stage.scene.add(this.belt);
    const gap = BELT.length / BELT.boxes;
    for (let i = 0; i < BELT.boxes; i++) this.riders.push({ box: this.ride(), x: -BELT.length / 2 + gap * (i + 0.5) });

    // The check-in desk: a sealed box with the cat on top.
    this.desk = createBox(buildBoxSpec(randomToken()));
    this.desk.group.rotation.y = -0.25;
    this.desk.group.position.set(-0.35, 0, 0.35);
    this.desk.group.userData.pick = "cat";
    this.catHolder.position.set(-0.35, BOX_SIZE.height, 0.35);
    this.catHolder.rotation.y = 0.15;
    this.catHolder.userData.pick = "cat";
    this.ratHolder.position.set(1.15, 0, 0.75);
    this.ratHolder.rotation.y = -0.6;
    this.ratHolder.userData.pick = "rat";
    stage.scene.add(this.desk.group, this.catHolder, this.ratHolder);
    stage.pickables.push(this.desk.group, this.catHolder, this.ratHolder);

    this.bubble = stage.addLabel("pop-bubble gate-bubble", new Vector3(-0.2, BOX_SIZE.height + 1.15, 0.35));
    stage.onSelect = (id) => (id === "rat" ? this.pokeRat() : this.pokeCat());
    stage.onLayout = (aspect) =>
      aspect < 0.9
        ? stage.frame(new Vector3(0.15, 0.85, 0), 3.4, 3.2, new Vector3(0, 0.35, 1))
        : stage.frame(new Vector3(0.1, 0.75, -0.2), 5.6, 2.5, new Vector3(0.1, 0.32, 1));
    stage.onLayout(1);
    stage.onFrame((time, dt) => this.update(time, dt));
    this.nextCat();
    this.nextRat();
  }

  /** The cat's line, until `seconds` have passed (for good when omitted). */
  say(text: string | null, seconds?: number): void {
    this.bubble.textContent = text ?? "";
    this.bubble.classList.toggle("on", !!text);
    this.sayUntil = seconds === undefined ? Infinity : this.now + seconds;
    this.stage.wake();
  }

  /** Boarded: the cat hops for joy. */
  cheer(): void {
    if (!this.stage.reduced) this.catHop = this.now;
    this.swapped = true;
    this.stage.wake();
  }

  pokeCat(): void {
    pageSound.resume();
    if (this.catSpec) catVoice(this.catSpec);
    if (this.catHop >= 0) return;
    if (this.stage.reduced) return this.nextCat();
    this.catHop = this.now;
    this.swapped = false;
    this.stage.wake();
  }

  pokeRat(): void {
    pageSound.resume();
    pageSound.squeak();
    if (this.ratHop < 0 && !this.stage.reduced) this.ratHop = this.now;
    this.stage.wake();
  }

  dispose(): void {
    this.cat?.dispose();
    this.rat?.dispose();
    for (const r of this.riders) r.box.dispose();
    this.desk.dispose();
    this.beltTex.dispose();
    this.stage.dispose();
  }

  private ride(): BoxObject {
    const box = createBox(buildBoxSpec(randomToken()));
    box.group.scale.setScalar(BELT.scale);
    box.group.rotation.y = (Math.random() - 0.5) * 0.5;
    this.stage.scene.add(box.group);
    return box;
  }

  private nextCat(): void {
    if (this.cat) {
      this.catHolder.remove(this.cat.group);
      this.cat.dispose();
    }
    this.catSpec = buildCatSpec({ seed: randomSeed() });
    this.cat = createCat(this.catSpec);
    this.catHolder.add(this.cat.group);
    this.stage.wake();
  }

  private nextRat(): void {
    this.rat = createRat(buildRatSpec(randomSeed()));
    this.ratHolder.add(this.rat.group);
  }

  private update(time: number, dt: number): void {
    this.now = time;
    if (this.bubble.classList.contains("on") && time > this.sayUntil) this.bubble.classList.remove("on");

    if (!this.stage.reduced) {
      // The belt runs; a box that falls off the end comes back on at the start as another box.
      this.beltTex.offset.x -= (BELT.speed * dt) / 1.2;
      for (const r of this.riders) {
        r.x += BELT.speed * dt;
        if (r.x > BELT.length / 2) {
          r.box.group.removeFromParent();
          r.box.dispose();
          r.box = this.ride();
          r.x -= BELT.length;
        }
      }
    }
    for (const r of this.riders) {
      // Boxes tip in and out at the ends of the belt.
      const edge = Math.min(1, (BELT.length / 2 - Math.abs(r.x)) / 0.35);
      r.box.group.position.set(r.x, BELT.height - (1 - Math.max(0, edge)) * 0.3, BELT.z);
      r.box.group.scale.setScalar(BELT.scale * Math.max(0.01, Math.min(1, edge + 0.15)));
    }

    if (this.catHop >= 0) {
      const t = (time - this.catHop) / HOP;
      if (t >= 0.5 && !this.swapped) {
        this.swapped = true;
        this.nextCat();
      }
      if (t >= 1) {
        this.catHop = -1;
        this.catHolder.position.y = BOX_SIZE.height;
      } else this.catHolder.position.y = BOX_SIZE.height + Math.sin(Math.PI * t) * 0.5;
    }
    if (this.ratHop >= 0) {
      const t = (time - this.ratHop) / HOP;
      if (t >= 1) {
        this.ratHop = -1;
        this.ratHolder.position.y = 0;
        this.ratHolder.rotation.y = -0.6;
      } else {
        this.ratHolder.position.y = Math.sin(Math.PI * t) * 0.4;
        this.ratHolder.rotation.y = -0.6 + Math.PI * 2 * t;
      }
    }
    this.cat?.update(time);
    this.rat?.update(time);
  }
}
