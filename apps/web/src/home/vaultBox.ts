import { BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, SpotLight, Vector3 } from "three";
import { spec } from "@dno/game-spec";
import { buildBoxSpec } from "@dno/generator";
import { BOX_SIZE, createBox, type BoxObject } from "@dno/scene";
import { PALETTE, Stage } from "../docs/three/stage";
import { pageSound } from "./sound";

/** What the scene is showing: the caption under it follows. */
export type VaultStep = "deposit" | "seal" | "encrypt" | "shuffle" | "list";

/** When each step starts, in seconds from the top of a loop, and how long a loop lasts. */
const TIMELINE: [VaultStep, number][] = [
  ["deposit", 0],
  ["seal", 2.4],
  ["encrypt", 4.0],
  ["shuffle", 5.8],
  ["list", 9.6],
];
const LOOP = 13.4;

const { width: W, height: H, wall: T } = BOX_SIZE;
/** Where the three boxes stand during the shuffle. */
const SLOT = 1.75;
/** Swaps of the shuffle: which two slots trade places, the first passing in front. */
const SWAPS: [number, number][] = [
  [1, 2],
  [0, 1],
  [1, 2],
];
const SWAP_TIME = 0.95;
const OWNER = "0xA11CE…7F3";
const CIPHER = "▓▒░█▒▓░";

const span = (t: number, a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
const randomToken = () => Math.floor(Math.random() * spec.collection.maxSupply);

/** A small portrait in the style of the NFTs people keep: a pixel cat with shades, on a flat colour. */
function nftTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 160;
  const g = c.getContext("2d")!;
  const px = 10;
  const dot = (x: number, y: number, color: string, w = 1, h = 1) => {
    g.fillStyle = color;
    g.fillRect(x * px, y * px, w * px, h * px);
  };
  dot(0, 0, "#9CC7F0", 16, 16);
  const fur = "#E8893A";
  const ink = "#1C1814";
  // Ears, head, cheeks.
  dot(3, 3, fur, 2, 2);
  dot(11, 3, fur, 2, 2);
  dot(3, 5, fur, 10, 7);
  dot(2, 7, fur, 1, 4);
  dot(13, 7, fur, 1, 4);
  dot(4, 4, "#F7A8C4");
  dot(11, 4, "#F7A8C4");
  // Shades.
  dot(3, 7, ink, 10, 1);
  dot(4, 8, ink, 3, 2);
  dot(9, 8, ink, 3, 2);
  dot(5, 8, "#7DE3D0");
  dot(10, 8, "#7DE3D0");
  // Nose, mouth, body.
  dot(7, 10, "#F7A8C4", 2, 1);
  dot(6, 11, ink, 1, 1);
  dot(9, 11, ink, 1, 1);
  dot(7, 11, ink, 2, 1);
  dot(4, 12, fur, 8, 4);
  dot(6, 13, "#F6EEDB", 4, 3);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** The NFT as a framed card, its origin at its bottom edge. */
function nftCard(): Group {
  const card = new Group();
  const frame = new Mesh(new BoxGeometry(0.78, 0.78, 0.05), new MeshBasicMaterial({ color: PALETTE.ink }));
  frame.position.y = 0.39;
  const picture = new Mesh(new PlaneGeometry(0.66, 0.66), new MeshBasicMaterial({ map: nftTexture() }));
  picture.position.set(0, 0.39, 0.027);
  const back = picture.clone();
  back.rotation.y = Math.PI;
  back.position.z = -0.027;
  card.add(frame, picture, back);
  return card;
}

interface Slotted {
  box: BoxObject;
  label: HTMLElement;
  /** Slot the box stands in, from 0 (left) to 2 (right). */
  slot: number;
}

/**
 * The home page's picture of the sealed vault, on a loop: an NFT drops into an open box, the box
 * folds shut and tapes itself, its holder's address scrambles, two lookalike boxes join it and the
 * three are shuffled (nobody can follow which one is whose), then a Seaport price tag pops up with
 * the vault as the seller. A click starts it again. Under reduced motion it holds the last frame.
 */
export class VaultBoxScene {
  onStep: ((step: VaultStep) => void) | null = null;

  private readonly stage: Stage;
  private readonly main: Slotted;
  private readonly decoys: Slotted[];
  private readonly card: Group;
  private readonly price: HTMLElement;
  private t = 0;
  private step: VaultStep | null = null;
  /** Sounds only once the visitor has touched the scene: a loop that rattles on its own would wear. */
  private heard = false;
  private readonly fired = new Set<string>();
  private width = 3.2;
  private readonly holder: string;

  constructor(host: HTMLElement, labels: { holder: string; price: string; seller: string }) {
    this.holder = labels.holder;
    const stage = (this.stage = new Stage(host));
    stage.addGround(3, 1.4, 0);
    const lamp = new SpotLight(PALETTE.sodium, 30, 10, 0.75, 0.7, 1.5);
    lamp.position.set(0.8, 4.4, 2);
    lamp.target.position.set(0, H / 2, 0);
    stage.scene.add(lamp, lamp.target);

    const make = (slot: number): Slotted => {
      const box = createBox(buildBoxSpec(randomToken()));
      box.group.rotation.y = -0.3;
      box.group.userData.pick = "vault";
      stage.scene.add(box.group);
      stage.pickables.push(box.group);
      const label = stage.addLabel("vault-holder", new Vector3(0, H + 0.32, 0), box.group);
      return { box, label, slot };
    };
    this.main = make(1);
    this.decoys = [make(0), make(2)];
    this.main.label.textContent = `${labels.holder} ${OWNER}`;
    for (const d of this.decoys) d.label.textContent = `${labels.holder} ${CIPHER}`;

    this.card = nftCard();
    this.card.position.z = 0.02;
    this.main.box.body.add(this.card);

    this.price = stage.addLabel("vault-price", new Vector3(0, H + 0.95, 0), this.main.box.group);
    this.price.innerHTML = `<b>${labels.price}</b><span>${labels.seller}</span>`;

    stage.onSelect = () => this.restart();
    stage.onLayout = () => this.frame();
    stage.onLayout(1);
    stage.onFrame((_time, dt) => this.update(dt));
    this.t = stage.reduced ? LOOP - 1.4 : 0;
    this.update(0);
  }

  /** Back to the NFT above an open box. */
  restart(): void {
    this.heard = true;
    pageSound.resume();
    if (this.stage.reduced) return;
    this.t = 0;
    this.fired.clear();
    this.stage.wake();
  }

  dispose(): void {
    for (const s of [this.main, ...this.decoys]) {
      s.box.group.removeFromParent();
      s.box.dispose();
    }
    this.stage.dispose();
  }

  private frame(): void {
    this.stage.frame(new Vector3(0, 1.05, 0), this.width, 3.1, new Vector3(0.2, 0.42, 1));
  }

  /** A sound, once per loop, if the visitor has asked for them. */
  private once(key: string, play: () => void): void {
    if (this.fired.has(key)) return;
    this.fired.add(key);
    if (this.heard) play();
  }

  private update(dt: number): void {
    const reduced = this.stage.reduced;
    if (!reduced) this.t = (this.t + dt) % LOOP;
    if (this.t < dt) this.fired.clear();
    const t = this.t;

    const step = [...TIMELINE].reverse().find(([, at]) => t >= at)![0];
    if (step !== this.step) {
      this.step = step;
      this.onStep?.(step);
    }

    const { box } = this.main;
    const { flaps, tape, interior } = box;

    // 0 - 2.2: the NFT floats down into the open box.
    const drop = easeInOut(span(t, 0.9, 2.2));
    this.card.position.y = 1.35 * (1 - drop) + 0.06 * drop;
    this.card.rotation.y = (1 - drop) * Math.sin(t * 2.2) * 0.35;
    this.card.visible = t < 3.4;
    if (drop >= 1) this.once("land", () => pageSound.impact(0.25));

    // 2.4 - 3.4: minor flaps fold in, then the majors over them; 3.4 - 3.9 the tape runs along.
    const minor = 1 - easeInOut(span(t, 2.4, 2.9));
    const major = 1 - easeInOut(span(t, 2.75, 3.35));
    flaps.minor[0].rotation.z = minor * 2.3;
    flaps.minor[1].rotation.z = -minor * 2.3;
    flaps.major[0].rotation.x = major * 2.6;
    flaps.major[1].rotation.x = -major * 2.6;
    interior.position.y = major > 0.05 ? T + 0.003 : H - T * 1.6;
    const zip = span(t, 3.4, 3.9);
    tape.visible = zip > 0;
    tape.scale.set(Math.max(0.001, zip), 1, 1);
    if (major <= 0) this.once("shut", () => pageSound.impact(0.35));
    if (zip > 0) this.once("tape", () => pageSound.rip());

    // 4.0 - 5.4: the holder's address scrambles, one character at a time.
    const scramble = span(t, 4.1, 5.4);
    const shown = Math.round(OWNER.length * (1 - scramble));
    this.main.label.textContent = `${this.holder} ${OWNER.slice(0, shown)}${CIPHER.slice(0, Math.max(0, CIPHER.length - shown))}`;
    this.main.label.classList.toggle("sealed", scramble >= 1);
    this.main.label.classList.toggle("on", t >= 0.2 && t < LOOP - 0.4);

    // 5.8 - 6.6: two lookalikes drop in beside it; 6.8 - 9.6: the three trade places.
    const arrive = span(t, 5.8, 6.6);
    const shuffling = t >= 5.8 && t < LOOP - 0.5;
    for (const d of this.decoys) {
      const k = t < 5.8 ? 0 : shuffling ? easeOutBack(arrive) : Math.max(0, 1 - span(t, LOOP - 0.5, LOOP - 0.1));
      d.box.group.scale.setScalar(Math.max(0.001, k));
      d.box.group.visible = k > 0.002;
      d.label.classList.toggle("on", shuffling && arrive >= 1);
      d.label.classList.add("sealed");
    }
    if (arrive > 0) this.once("arrive", () => pageSound.whoosh());

    // Where each box stands: replay the swaps up to now.
    const order = [0, 1, 2]; // order[slot] = which box (0 left decoy, 1 main, 2 right decoy)
    const at = [-SLOT, 0, SLOT];
    const boxes = [this.decoys[0]!, this.main, this.decoys[1]!];
    const pos = boxes.map((_, i) => ({ x: at[i]!, z: 0 }));
    SWAPS.forEach(([a, b], i) => {
      const k = easeInOut(span(t, 6.8 + i * SWAP_TIME, 6.8 + (i + 1) * SWAP_TIME - 0.1));
      if (k <= 0) return;
      const front = order[a]!;
      const back = order[b]!;
      const xa = at[a]!;
      const xb = at[b]!;
      pos[front] = { x: xa + (xb - xa) * k, z: Math.sin(k * Math.PI) * 0.75 };
      pos[back] = { x: xb + (xa - xb) * k, z: -Math.sin(k * Math.PI) * 0.75 };
      if (k >= 1) [order[a], order[b]] = [order[b]!, order[a]!];
      if (k > 0) this.once(`swap${i}`, () => pageSound.impact(0.12));
    });
    boxes.forEach((b, i) => b.box.group.position.set(pos[i]!.x, 0, pos[i]!.z));
    // Wider frame while there are three.
    const wide = Math.max(arrive, 0) > 0 && shuffling ? 1 : 0;
    const width = 3.2 + (5.8 - 3.2) * wide;
    if (Math.abs(width - this.width) > 0.001) {
      this.width += (width - this.width) * Math.min(1, dt * 3 || 1);
      this.frame();
    }

    // 9.6 - end: a Seaport price tag pops over the box, the vault as the seller.
    this.price.classList.toggle("on", t >= 9.8 && t < LOOP - 0.5);
    if (t >= 9.8) this.once("price", () => pageSound.impact(0.18));

    if (!reduced) for (const s of boxes) s.box.group.rotation.y = -0.3 + Math.sin(this.t * 0.8 + s.slot) * 0.05;
  }
}
