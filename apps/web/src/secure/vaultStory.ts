import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PointLight,
  Points,
  PointsMaterial,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  Vector4,
} from "three";
import { spec } from "@dno/game-spec";
import { buildBoxSpec } from "@dno/generator";
import { BOX_SIZE, createBox, type BoxObject } from "@dno/scene";
import { Stage } from "../docs/three/stage";
import { tokenLogoUrl } from "../brand/logos";
import { scramble, shieldGlow } from "./shieldScene";

/** Seconds each step plays, and the whole loop. */
export const STEP = 4.6;
export const STEPS = 4;
const LOOP = STEP * STEPS;
/** The shield, where a probe starts, and how fast it flies. */
const R = 1.35;
const START = 4.4;
const SPEED = 2.8;
const TEAL = new Color("#5BE3C2");
const UP = new Vector3(0, 1, 0);
const RED = new Color("#FF4D3D");
const H = BOX_SIZE.height;
/** The flaps' open angles, as the opening sequence leaves them. */
const MAJOR = 2.6;
const MINOR = 2.3;
/** Where the wallet signs, and where the NFT comes out. */
const WALLET = new Vector3(-1.85, 0.4, 0.2);
const FRESH = new Vector3(1.85, -0.5, 0.2);
/** The ways out in step three, on a slow orbit: a listing, a buyer's offer, a private sale, a gift, and the NFT's perks lent to a delegate. */
const ORBIT = 2.05;
const ROUTES = ["seaport", "offer", "private", "gift", "delegate"] as const;
/** The coins a loop seals instead of the NFT, in the order they drop in. */
const COINS = ["cZAMA", "WETH", "cUSDC", "cUSDT", "ETH"] as const;
/** A coin's radius and thickness: five lie apart on the box's floor, well inside its walls. */
const COIN_R = 0.18;
const COIN_T = 0.055;
/** Where each coin lands on the floor, in the box's own frame (x across, z in depth): the back two, the middle, the front two. */
const COIN_SPOTS = [
  new Vector3(-0.32, 0, -0.24),
  new Vector3(0.32, 0, -0.24),
  new Vector3(0, 0, 0),
  new Vector3(-0.32, 0, 0.24),
  new Vector3(0.32, 0, 0.24),
];
/** Step one: when the first coin shows above the box, and how far apart the next ones do. */
const COIN_FIRST = 0.06;
const COIN_PACE = 0.38;
/** Where a coin hovers before it drops, and the tilt that turns its face to the camera. */
const COIN_HOVER = 1.5;
const COIN_FACE = Math.PI / 2 - 0.2;
/** The same orbit when the loop seals tokens: where a pocket's cUSDC goes. */
const TOKEN_ROUTES = ["toPocket", "payBox", "paidIn", "saleCash", "hiddenBalance"] as const;
/** When the first way out lights up in step three, and how far apart the next ones do. */
const ROUTE_START = 0.35;
const ROUTE_GAP = 0.72;
/** Probes that hit the shield in step three: when they start, and where from. */
const PROBES = [
  { at: 0.5, dir: new Vector3(-0.8, 0.55, 0.45).normalize() },
  { at: 1.7, dir: new Vector3(0.75, 0.7, 0.3).normalize() },
  { at: 2.9, dir: new Vector3(-0.2, 0.9, 0.6).normalize() },
];
const SPARKS = 70;
/** Where the key goes through the shield, from the wallet's side. */
const KEY_IN = new Vector3(-0.72, 0.62, 0.3).normalize();

export interface StoryLabels {
  public: string;
  /** The deposit's tag when the loop seals tokens: public, its amount not. */
  publicTokens: string;
  toPocket: string;
  payBox: string;
  paidIn: string;
  saleCash: string;
  hiddenBalance: string;
  holder: string;
  denied: string;
  signature: string;
  key: string;
  keyOk: string;
  seaport: string;
  offer: string;
  private: string;
  gift: string;
  delegate: string;
  fresh: string;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOutBack = (x: number) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
const easeIn = (x: number) => x * x;
/** Rises over [a, b], holds, falls over [c, d]. */
const window4 = (t: number, a: number, b: number, c: number, d: number) => span(t, a, b) * (1 - span(t, c, d));

/** A little pixel portrait, mirrored like an identicon, on a card: some NFT, any NFT. */
/** A coin's face: its token's official logo, painted on a canvas once the SVG has loaded. */
function coinFaceMaterial(symbol: string): MeshStandardMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const url = tokenLogoUrl(symbol);
  if (url) {
    const img = new Image();
    img.onload = () => {
      const g = canvas.getContext("2d");
      if (!g) return;
      // The cylinder's cap shows the canvas a quarter turn clockwise once the coin faces the viewer:
      // draw it a quarter turn the other way.
      g.translate(0, 256);
      g.rotate(-Math.PI / 2);
      g.drawImage(img, 0, 0, 256, 256);
      texture.needsUpdate = true;
    };
    img.src = url;
  }
  return new MeshStandardMaterial({ map: texture, emissive: new Color("#ffffff"), emissiveMap: texture, emissiveIntensity: 0.45, metalness: 0.25, roughness: 0.45 });
}

function drawArt(canvas: HTMLCanvasElement, token: number): void {
  const g = canvas.getContext("2d")!;
  const S = canvas.width;
  const hue = Math.floor(Math.random() * 360);
  const bg = g.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, `hsl(${hue} 70% 22%)`);
  bg.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 12%)`);
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);
  const cells = 9;
  const px = Math.floor((S * 0.62) / cells);
  const ox = (S - px * cells) / 2;
  const oy = S * 0.12;
  const colors = [`hsl(${(hue + 180) % 360} 85% 62%)`, `hsl(${(hue + 210) % 360} 80% 72%)`, `hsl(${(hue + 30) % 360} 90% 60%)`];
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < Math.ceil(cells / 2); x++) {
      const r = Math.random();
      // Denser in the middle, like a face rather than noise.
      if (r > 0.62 - Math.abs(y - cells / 2) * 0.03) continue;
      g.fillStyle = colors[Math.floor(r * 10) % colors.length]!;
      g.fillRect(ox + x * px, oy + y * px, px, px);
      g.fillRect(ox + (cells - 1 - x) * px, oy + y * px, px, px);
    }
  }
  g.fillStyle = "#07090c";
  g.fillRect(ox + 2 * px, oy + 3 * px, px, px);
  g.fillRect(ox + (cells - 3) * px, oy + 3 * px, px, px);
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.font = `600 ${Math.round(S * 0.075)}px ui-monospace, Menlo, monospace`;
  g.textAlign = "left";
  g.fillText(`#${token}`, S * 0.08, S * 0.92);
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.lineWidth = S * 0.012;
  g.strokeRect(S * 0.03, S * 0.03, S * 0.94, S * 0.94);
}

/**
 * The secure home page's picture: the vault's four steps, on a loop, one loop with an NFT and
 * the next with a stack of cUSDC, as the vault takes both.
 * 1. An NFT (or tokens) drops into an open box, the flaps fold, the tape runs, the shield rises.
 * 2. A wallet signs once, a key comes out of it and dissolves into the box: nobody reads it.
 * 3. Five ways out turn around the box (a Seaport listing, a buyer's offer, a private sale,
 *    a gift, a delegate for its perks; for tokens, another pocket, paying for a box, a payment
 *    coming in, a sale's cUSDC, a balance nobody reads) while probes trying to read its holder
 *    bounce off the shield.
 * 4. The key matches, the shield drops, the box opens and the NFT (or the tokens) flies to a
 *    fresh address.
 * Every pose is a function of the loop's clock, so a step can be shown at once. Under reduced
 * motion it holds a still of each step.
 */
export class VaultStoryScene {
  /** Fires when the step changes (0 to 3). */
  onStep: ((step: number) => void) | null = null;
  /** Fires every frame with the current step's progress, 0 to 1. */
  onProgress: ((progress: number) => void) | null = null;

  private readonly stage: Stage;
  private readonly box: BoxObject;
  private readonly boxRoot = new Group();
  private readonly tapeMaterials: { opacity: number; transparent: boolean }[] = [];
  private readonly shell = new Group();
  private readonly lattice: LineSegments;
  private readonly glow: ShaderMaterial;
  private readonly card = new Group();
  /** The tokens a loop seals instead of the NFT: one coin each, dropped in one after another. */
  private readonly coins = new Group();
  /** Each coin's spin (about the vertical) and, inside, its tilt from flat to facing the camera. */
  private readonly coinHolders: { spin: Group; tilt: Mesh }[] = [];
  private readonly coinLight: PointLight;
  /** Whether this loop seals tokens rather than an NFT. */
  private tokens = false;
  private readonly art: CanvasTexture;
  private readonly cardLight: PointLight;
  private readonly wallet = new Group();
  private readonly walletMaterials: (MeshStandardMaterial | LineBasicMaterial)[] = [];
  private readonly signature: Line;
  private readonly key = new Group();
  private readonly keyLight: PointLight;
  private readonly sparks: Points;
  private readonly sparkSeeds: Vector3[] = [];
  private readonly orbit = new Group();
  private readonly orbitRing: Mesh;
  private readonly nodes: Mesh[] = [];
  private readonly packets: Mesh[] = [];
  private readonly probes: {
    dot: Mesh;
    trail: Line;
    tag: HTMLElement;
    at: Vector3;
  }[] = [];
  private readonly pad = new Group();
  private readonly padGlow: MeshBasicMaterial;
  private readonly padRing: MeshBasicMaterial;
  private readonly tags: Record<"public" | "holder" | "key" | "signature" | "fresh", HTMLElement>;
  private readonly routeTags: HTMLElement[] = [];
  private readonly labels: StoryLabels;
  private time = 0;
  private step = -1;
  private scrambleAt = 0;
  private paused = false;

  constructor(host: HTMLElement, labels: StoryLabels) {
    this.labels = labels;
    const stage = (this.stage = new Stage(host));

    // The box, opened.
    const token = Math.floor(Math.random() * spec.collection.maxSupply);
    const box = (this.box = createBox(buildBoxSpec(token)));
    box.group.position.y = -H / 2;
    this.boxRoot.add(box.group);
    stage.scene.add(this.boxRoot);
    box.tape.traverse((o) => {
      const m = (o as Mesh).material as MeshStandardMaterial | undefined;
      if (m && "opacity" in m) this.tapeMaterials.push(m);
    });
    const cold = new PointLight(TEAL, 5, 6, 1.6);
    cold.position.set(-1.6, 1.2, 1.6);
    stage.scene.add(cold);

    // The shield.
    this.lattice = new LineSegments(
      new EdgesGeometry(new IcosahedronGeometry(R, 1)),
      new LineBasicMaterial({
        color: TEAL,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    this.glow = shieldGlow(PROBES.length + 1);
    this.shell.add(this.lattice, new Mesh(new SphereGeometry(R, 64, 40), this.glow));
    stage.scene.add(this.shell);

    // The NFT: a card with its picture on both faces and a light that follows it.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    drawArt(canvas, Math.floor(Math.random() * 9000) + 1000);
    this.art = new CanvasTexture(canvas);
    this.art.colorSpace = SRGBColorSpace;
    const face = new MeshBasicMaterial({ map: this.art, toneMapped: false });
    const slab = new Mesh(new BoxGeometry(0.78, 0.78, 0.025), [
      new MeshBasicMaterial({ color: "#0d1117" }),
      new MeshBasicMaterial({ color: "#0d1117" }),
      new MeshBasicMaterial({ color: "#0d1117" }),
      new MeshBasicMaterial({ color: "#0d1117" }),
      face,
      face,
    ]);
    const rim = new LineSegments(new EdgesGeometry(slab.geometry), new LineBasicMaterial({ color: TEAL, transparent: true, opacity: 0.9 }));
    this.cardLight = new PointLight(TEAL, 0, 3, 1.5);
    this.card.add(slab, rim, this.cardLight);
    stage.scene.add(this.card);

    // The tokens: a coin per token, each wearing its token's logo, the edge in the vault's metal
    // and light. They come one at a time, apart, never as a heap.
    const coinSide = new MeshStandardMaterial({ color: "#2E8C78", emissive: TEAL, emissiveIntensity: 0.35, metalness: 0.7, roughness: 0.35 });
    const coinEdge = new LineBasicMaterial({ color: TEAL, transparent: true, opacity: 0.9 });
    const coinGeometry = new CylinderGeometry(COIN_R, COIN_R, COIN_T, 48);
    const coinRim = new EdgesGeometry(coinGeometry, 30);
    for (const symbol of COINS) {
      const face = coinFaceMaterial(symbol);
      const tilt = new Mesh(coinGeometry, [coinSide, face, face]);
      tilt.add(new LineSegments(coinRim, coinEdge));
      const spin = new Group();
      spin.add(tilt);
      this.coins.add(spin);
      this.coinHolders.push({ spin, tilt });
    }
    this.coinLight = new PointLight(TEAL, 0, 3, 1.5);
    this.coins.add(this.coinLight);
    this.coins.visible = false;
    stage.scene.add(this.coins);

    // The wallet that signs once, and its signature, drawn as it is made.
    const walletBody = new MeshStandardMaterial({
      color: "#121820",
      roughness: 0.5,
      metalness: 0.4,
      transparent: true,
    });
    const walletEdge = new LineBasicMaterial({
      color: TEAL,
      transparent: true,
    });
    this.walletMaterials.push(walletBody, walletEdge);
    const walletSlab = new Mesh(new BoxGeometry(0.8, 0.5, 0.05), walletBody);
    this.wallet.add(walletSlab, new LineSegments(new EdgesGeometry(walletSlab.geometry), walletEdge));
    const sig: number[] = [];
    for (let i = 0; i <= 80; i++) {
      const u = i / 80;
      const x = -0.28 + u * 0.56;
      sig.push(x, -0.04 + Math.sin(u * 19) * 0.07 * Math.sin(u * Math.PI) + u * 0.04, 0.03);
    }
    const sigGeometry = new BufferGeometry();
    sigGeometry.setAttribute("position", new Float32BufferAttribute(sig, 3));
    const sigMaterial = new LineBasicMaterial({
      color: "#E6EDF3",
      transparent: true,
    });
    this.walletMaterials.push(sigMaterial);
    this.signature = new Line(sigGeometry, sigMaterial);
    this.wallet.add(this.signature);
    this.wallet.position.copy(WALLET);
    this.wallet.rotation.y = 0.35;
    stage.scene.add(this.wallet);

    // The key: a bow, a shaft, two bits, glowing.
    const keyMaterial = new MeshStandardMaterial({
      color: TEAL,
      emissive: TEAL,
      emissiveIntensity: 1.3,
      metalness: 0.6,
      roughness: 0.3,
    });
    const bow = new Mesh(new TorusGeometry(0.1, 0.028, 10, 28), keyMaterial);
    const shaft = new Mesh(new BoxGeometry(0.34, 0.045, 0.045), keyMaterial);
    shaft.position.x = 0.27;
    const bit1 = new Mesh(new BoxGeometry(0.045, 0.09, 0.045), keyMaterial);
    bit1.position.set(0.36, -0.06, 0);
    const bit2 = new Mesh(new BoxGeometry(0.045, 0.06, 0.045), keyMaterial);
    bit2.position.set(0.42, -0.045, 0);
    const keyBody = new Group();
    keyBody.add(bow, shaft, bit1, bit2);
    keyBody.position.x = -0.22;
    this.keyLight = new PointLight(TEAL, 0, 3, 1.5);
    this.key.add(keyBody, this.keyLight);
    stage.scene.add(this.key);

    // What is left of the key once it goes through the shield: sparks drawn into the box.
    const sparkGeometry = new BufferGeometry();
    sparkGeometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(SPARKS * 3), 3));
    for (let i = 0; i < SPARKS; i++)
      this.sparkSeeds.push(new Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(0.2 + Math.random() * 0.5));
    this.sparks = new Points(
      sparkGeometry,
      new PointsMaterial({
        color: "#9FFFE9",
        size: 0.05,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      })
    );
    stage.scene.add(this.sparks);

    // The ways out: an orbit with a node for each, and a packet for each.
    this.orbitRing = new Mesh(
      new TorusGeometry(ORBIT, 0.005, 6, 200),
      new MeshBasicMaterial({
        color: TEAL,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      })
    );
    this.orbitRing.rotation.x = Math.PI / 2;
    this.orbit.add(this.orbitRing);
    const nodeGeometry = new OctahedronGeometry(0.13, 0);
    const packetGeometry = new SphereGeometry(0.04, 12, 8);
    ROUTES.forEach((route, i) => {
      const node = new Mesh(
        nodeGeometry,
        new MeshBasicMaterial({
          color: TEAL,
          wireframe: true,
          transparent: true,
        })
      );
      const a = (i / ROUTES.length) * Math.PI * 2;
      node.position.set(Math.cos(a) * ORBIT, 0, Math.sin(a) * ORBIT);
      this.orbit.add(node);
      this.nodes.push(node);
      const packet = new Mesh(packetGeometry, new MeshBasicMaterial({ color: "#9FFFE9", transparent: true }));
      stage.scene.add(packet);
      this.packets.push(packet);
      const tag = stage.addLabel("story-tag story-route", new Vector3(0, 0.3, 0), node);
      tag.textContent = labels[route];
      this.routeTags.push(tag);
    });
    this.orbit.position.y = 0.35;
    this.orbit.rotation.x = 0.12;
    stage.scene.add(this.orbit);

    // Probes trying to read the holder, each with its "refused" tag.
    const probeGeometry = new SphereGeometry(0.035, 12, 8);
    for (const _ of PROBES) {
      const dot = new Mesh(probeGeometry, new MeshBasicMaterial({ color: RED }));
      const trail = new Line(new BufferGeometry(), new LineBasicMaterial({ color: RED, transparent: true, opacity: 0.6 }));
      trail.geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
      stage.scene.add(dot, trail);
      const at = new Vector3();
      const tag = stage.addLabel("shield-denied story-denied", at);
      tag.textContent = labels.denied;
      this.probes.push({ dot, trail, tag, at });
    }

    // The fresh address the NFT lands on.
    this.padRing = new MeshBasicMaterial({
      color: TEAL,
      transparent: true,
      depthWrite: false,
    });
    const ring = new Mesh(new TorusGeometry(0.42, 0.012, 8, 80), this.padRing);
    ring.rotation.x = Math.PI / 2;
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 128;
    const g = glowCanvas.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, "rgba(159,255,233,0.9)");
    grad.addColorStop(0.5, "rgba(91,227,194,0.25)");
    grad.addColorStop(1, "rgba(91,227,194,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.padGlow = new MeshBasicMaterial({
      map: new CanvasTexture(glowCanvas),
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const disc = new Mesh(new CircleGeometry(0.6, 48), this.padGlow);
    disc.rotation.x = -Math.PI / 2;
    this.pad.add(ring, disc);
    this.pad.position.copy(FRESH);
    stage.scene.add(this.pad);

    this.tags = {
      public: stage.addLabel("story-tag story-public", new Vector3(0, 0.5, 0), this.card),
      holder: stage.addLabel("shield-holder story-holder", new Vector3(0, H / 2 + 0.32, 0)),
      key: stage.addLabel("shield-holder story-key", new Vector3(0, -H / 2 - 0.3, 0.3)),
      signature: stage.addLabel("story-tag", new Vector3(0, -0.42, 0), this.wallet),
      fresh: stage.addLabel("story-tag story-fresh", new Vector3(0, -0.28, 0.3), this.pad),
    };
    this.tags.public.textContent = labels.public;
    this.tags.signature.textContent = labels.signature;
    this.tags.fresh.textContent = `${labels.fresh}\n0x${scramble(4).replace(/[^0-9a-f]/g, "c")}…${scramble(4).replace(/[^0-9a-f]/g, "e")}`;

    stage.onSelect = () => this.go((this.current() + 1) % STEPS);
    stage.pickables.push(this.boxRoot, this.shell);
    this.shell.userData.pick = "shield";
    stage.onLayout = (aspect) => {
      // Wide enough for the wallet and the fresh address on either side, tall enough for the NFT above.
      const wide = aspect >= 1;
      stage.frame(new Vector3(0, 0.45, 0), wide ? 5.1 : 4.9, wide ? 3.5 : 3.8, new Vector3(0.1, 0.26, 1));
      // Five ways out: on a phone their tags would run off the sides at the full orbit.
      this.orbit.scale.setScalar(host.clientWidth < 600 ? 0.8 : 1);
    };
    stage.onLayout(1);
    stage.onFrame((_t, dt) => this.update(dt));
    this.pose(this.stage.reduced ? this.stillOf(0) : 0);
  }

  /** Jumps to the start of a step (or, under reduced motion, to its still). */
  go(step: number): void {
    this.time = this.stage.reduced ? this.stillOf(step) : step * STEP;
    this.pose(this.time);
    this.stage.wake();
  }

  /** Holds the loop where it is, or lets it run. */
  pause(paused: boolean): void {
    this.paused = paused;
    this.stage.wake();
  }

  dispose(): void {
    this.box.group.removeFromParent();
    this.box.dispose();
    this.art.dispose();
    this.padGlow.map?.dispose();
    this.stage.dispose();
  }

  private current(): number {
    return Math.floor((this.time % LOOP) / STEP);
  }

  /** The moment each step is shown at when nothing moves. */
  private stillOf(step: number): number {
    return step * STEP + [4.4, 3.6, 2.35, 3.9][step]!;
  }

  private update(dt: number): void {
    if (!this.stage.reduced && !this.paused) {
      const before = Math.floor(this.time / LOOP);
      // A frame's first step can come out a hair below zero (its timestamp predates the wake).
      this.time += Math.max(0, dt);
      if (Math.floor(this.time / LOOP) !== before) this.newLoop();
    }
    this.pose(this.time);
  }

  /** Every other loop seals tokens; every NFT loop a new NFT. */
  private newLoop(): void {
    this.tokens = !this.tokens;
    if (!this.tokens) {
      drawArt(this.art.image as HTMLCanvasElement, Math.floor(Math.random() * 9000) + 1000);
      this.art.needsUpdate = true;
    }
    const routes = this.tokens ? TOKEN_ROUTES : ROUTES;
    routes.forEach((route, i) => (this.routeTags[i]!.textContent = this.labels[route]));
    this.tags.public.textContent = this.tokens ? this.labels.publicTokens : this.labels.public;
  }

  private pose(clock: number): void {
    const t = clock % LOOP;
    const step = Math.floor(t / STEP);
    const u = t - step * STEP;
    if (step !== this.step) {
      this.step = step;
      this.onStep?.(step);
    }
    this.onProgress?.(u / STEP);
    // Absolute times within the loop for each beat.
    const s1 = u + (step - 0) * STEP;
    const s2 = s1 - STEP;
    const s3 = s1 - 2 * STEP;
    const s4 = s1 - 3 * STEP;

    // The box sways a little, all along.
    this.boxRoot.rotation.y = -0.35 + Math.sin(clock * 0.45) * 0.14;
    this.boxRoot.position.y = Math.sin(clock * 1.1) * 0.025;

    // Flaps: open at the start, fold in step 1, open again in step 4.
    const close = step === 0 ? easeInOut(span(s1, 2.15, 2.85)) : step < 3 ? 1 : 1 - easeOutBack(span(s4, 1.0, 1.7));
    const closeMinor = step === 0 ? easeInOut(span(s1, 2.15, 2.6)) : close;
    const closeMajor = step === 0 ? easeInOut(span(s1, 2.4, 2.85)) : close;
    const { flaps, tape, interior } = this.box;
    flaps.major[0].rotation.x = MAJOR * (1 - closeMajor);
    flaps.major[1].rotation.x = -MAJOR * (1 - closeMajor);
    flaps.minor[0].rotation.z = MINOR * (1 - closeMinor);
    flaps.minor[1].rotation.z = -MINOR * (1 - closeMinor);
    interior.position.y = closeMajor > 0.98 ? H - BOX_SIZE.wall * 1.6 : BOX_SIZE.wall + 0.003;

    // Tape: runs along the seam after the flaps fold, rips off in step 4.
    const taped = step === 0 ? easeInOut(span(s1, 2.85, 3.3)) : 1;
    const rip = step === 3 ? easeInOut(span(s4, 0.55, 1.05)) : 0;
    tape.visible = taped > 0.001 && rip < 0.999;
    tape.scale.set(Math.max(0.001, taped), 1, 1);
    tape.position.set(rip * 0.5, rip * 0.9, -rip * 0.35);
    tape.rotation.set(rip * 0.7, 0, rip * 0.9);
    for (const m of this.tapeMaterials) {
      m.transparent = true;
      m.opacity = 0.93 * (1 - rip);
    }

    // The shield: rises once sealed, drops when the key matches.
    const shield = step === 0 ? easeInOut(span(s1, 3.2, 4.2)) : step < 3 ? 1 : 1 - easeInOut(span(s4, 0.45, 1.1));
    this.glow.uniforms.uTime!.value = t;
    this.glow.uniforms.uFade!.value = shield;
    (this.lattice.material as LineBasicMaterial).opacity = 0.28 * shield;
    this.shell.visible = shield > 0.001;
    this.shell.scale.setScalar(0.85 + 0.15 * shield);
    this.lattice.rotation.y = clock * 0.08;

    this.poseCard(step, s1, s4);
    this.poseKey(step, s2, s4);
    this.poseRoutes(step, s3, clock);
    this.posePad(step, s4);

    // The holder's tag: ciphertext from the seal until the box opens.
    const holder = step === 0 ? span(s1, 3.4, 3.9) : step < 3 ? 1 : 1 - span(s4, 0.5, 0.9);
    this.tags.holder.style.opacity = String(holder);
    if (clock > this.scrambleAt || this.stage.reduced) {
      this.scrambleAt = clock + 0.09;
      this.tags.holder.textContent = `${this.labels.holder} ${scramble(10)}`;
    }
  }

  private poseCard(step: number, s1: number, s4: number): void {
    this.coins.visible = this.tokens;
    if (this.tokens) {
      this.card.visible = false;
      this.cardLight.intensity = 0;
      // The card stays where the coins hover, invisible: the deposit's tag follows it.
      this.card.position.set(0, COIN_HOVER - 0.05, 0);
      this.poseCoins(step, s1, s4);
      this.tags.public.style.opacity = String(step === 0 ? window4(s1, 0.4, 0.8, 1.6, 1.9) : 0);
      return;
    }
    const card = this.card;
    let visible = true;
    let light = 0;
    if (step === 0) {
      // Appears above the box, turns, drops in, goes out of sight as the flaps fold.
      const born = easeOutBack(span(s1, 0.1, 0.6));
      const drop = easeIn(span(s1, 1.5, 2.1));
      card.scale.setScalar(Math.max(0.001, born));
      card.position.set(0, 1.85 - drop * 1.85, 0);
      card.rotation.set(0, (1 - span(s1, 1.0, 1.6)) * Math.sin(s1 * 2.2) * 0.9 + this.boxRoot.rotation.y * span(s1, 1.3, 1.8), 0);
      light = 1.5 * window4(s1, 0.1, 0.6, 1.9, 2.2) + 4 * window4(s1, 2.05, 2.15, 2.15, 2.7);
      visible = s1 < 2.85;
    } else if (step === 3) {
      // Rises out of the open box, then arcs to the fresh address and stands there.
      const rise = easeInOut(span(s4, 1.5, 2.3));
      const fly = easeInOut(span(s4, 2.35, 3.25));
      const out = 1 - span(s4, 4.05, 4.5);
      const from = new Vector3(0, rise * 1.35, 0);
      const to = new Vector3(FRESH.x, FRESH.y + 0.48, FRESH.z);
      card.position.lerpVectors(from, to, fly);
      card.position.y += Math.sin(fly * Math.PI) * 0.6;
      card.rotation.set(0, this.boxRoot.rotation.y * (1 - rise) + rise * (s4 - 1.5) * 1.6 * (1 - fly) + fly * -0.35, 0);
      card.scale.setScalar(Math.max(0.001, out));
      light = 1.5 * rise * out + 3 * window4(s4, 3.15, 3.25, 3.25, 3.8);
      visible = s4 > 1.45;
    } else {
      visible = false;
    }
    card.visible = visible;
    this.cardLight.intensity = light;
    this.tags.public.style.opacity = String(step === 0 ? window4(s1, 0.4, 0.8, 1.6, 1.9) : 0);
  }

  /** Where a coin lies on the box's floor, in the world, as the box sways and bobs. */
  private floorSpot(i: number, out: Vector3): Vector3 {
    const floor = -H / 2 + BOX_SIZE.wall + 0.006 + COIN_T / 2;
    return out.set(COIN_SPOTS[i]!.x, floor, COIN_SPOTS[i]!.z).applyAxisAngle(UP, this.boxRoot.rotation.y).add(this.boxRoot.position);
  }

  /**
   * Step one: each coin pops up above the box facing the camera, turns once, then drops and lies
   * flat on its own spot of the floor, the next one coming as it lands. Step four: they rise in
   * turn into a row above the open box, then fly one by one to the fresh address and stack there
   * with a gap between each.
   */
  private poseCoins(step: number, s1: number, s4: number): void {
    const spot = new Vector3();
    const from = new Vector3();
    const to = new Vector3();
    let light = 0;
    this.coinHolders.forEach(({ spin, tilt }, i) => {
      let visible = false;
      if (step === 0) {
        const t0 = COIN_FIRST + i * COIN_PACE;
        const born = easeOutBack(span(s1, t0, t0 + 0.2));
        const d = span(s1, t0 + 0.28, t0 + 0.56);
        this.floorSpot(i, spot);
        from.set(0, COIN_HOVER, 0.1);
        spin.position.set(from.x + (spot.x - from.x) * easeInOut(d), from.y + (spot.y - from.y) * easeIn(d), from.z + (spot.z - from.z) * easeInOut(d));
        const turn = (1 - easeInOut(span(s1, t0, t0 + 0.3))) * Math.PI * 2;
        spin.rotation.y = turn + (this.boxRoot.rotation.y - turn) * easeInOut(d);
        tilt.rotation.x = COIN_FACE * (1 - easeInOut(span(d, 0, 0.6)));
        // Shown a size up while it hovers, so its logo reads; its true size as it goes in.
        spin.scale.setScalar(Math.max(0.001, born * (1.35 - 0.35 * easeInOut(span(d, 0, 0.5)))));
        visible = s1 >= t0 && s1 < 2.85;
        light = Math.max(light, 1.6 * window4(s1, t0, t0 + 0.15, t0 + 0.45, t0 + 0.56));
      } else if (step === 3) {
        // Rise in turn into a row above the box, faces to the camera, with room between them; the
        // one nearest the fresh address leaves first, so no path crosses another.
        const r = easeInOut(span(s4, 1.5 + i * 0.1, 2.0 + i * 0.1));
        const k = COINS.length - 1 - i;
        const f = easeInOut(span(s4, 2.55 + k * 0.2, 3.1 + k * 0.2));
        const out = 1 - span(s4, 4.05, 4.5);
        this.floorSpot(i, spot);
        from.set((i - (COINS.length - 1) / 2) * (COIN_R * 2.4 + 0.14), 1.2, 0.1);
        from.lerpVectors(spot, from, r);
        // Then to the fresh address, landing flat, one above the other with a gap.
        to.set(FRESH.x, FRESH.y + 0.12 + k * (COIN_T + 0.08), FRESH.z);
        spin.position.lerpVectors(from, to, f);
        spin.position.y += Math.sin(f * Math.PI) * 0.45;
        spin.rotation.y = this.boxRoot.rotation.y * (1 - r) + f * (s4 - 3.15) * 0.8;
        tilt.rotation.x = COIN_FACE * r * (1 - f) + 0.18 * f;
        spin.scale.setScalar(Math.max(0.001, out * (1 + 0.2 * r * (1 - f))));
        visible = s4 > 1.45;
        light = Math.max(light, 1.5 * r * (1 - f) * out, 2.5 * window4(f, 0.85, 0.95, 0.95, 1) * out);
      }
      spin.visible = visible;
    });
    this.coinLight.position.set(0, step === 3 ? 1.2 : COIN_HOVER, 0.5);
    this.coinLight.intensity = light;
  }

  private poseKey(step: number, s2: number, s4: number): void {
    // The wallet: fades in, signs, fades out.
    const wallet = step === 1 ? window4(s2, 0, 0.4, 3.9, 4.5) : 0;
    this.wallet.visible = wallet > 0.001;
    this.wallet.scale.setScalar(0.85 + 0.15 * wallet);
    this.wallet.position.y = WALLET.y + Math.sin(s2 * 1.4) * 0.03;
    for (const m of this.walletMaterials) m.opacity = wallet;
    this.signature.geometry.setDrawRange(0, Math.floor(81 * span(s2, 0.45, 1.2)));
    this.tags.signature.style.opacity = String(wallet * span(s2, 0.4, 0.8));

    // The key: grows out of the wallet, arcs to the box, goes through the shield in sparks.
    const grow = easeOutBack(span(s2, 1.15, 1.6));
    const fly = easeInOut(span(s2, 1.75, 2.75));
    const inside = step === 1 && s2 > 1.1 && s2 < 2.8;
    this.key.visible = inside;
    if (inside) {
      const from = new Vector3(WALLET.x + 0.1, WALLET.y + 0.5, WALLET.z + 0.2);
      const to = new Vector3(0, 0.15, 0);
      this.key.position.lerpVectors(from, to, fly);
      this.key.position.y += Math.sin(fly * Math.PI) * 0.7;
      this.key.rotation.set(0.3, s2 * 3.2, Math.sin(s2 * 2) * 0.3);
      this.key.scale.setScalar(Math.max(0.001, grow * (1 - span(fly, 0.75, 1)) * 1.3));
    }
    this.keyLight.intensity = inside ? 2.5 * grow : 0;

    // The moment it crosses the shield: a ripple where it went in.
    const hits = this.glow.uniforms.uHits!.value as Vector4[];
    const crossing = step * STEP + 2.45;
    hits[PROBES.length]!.set(KEY_IN.x, KEY_IN.y, KEY_IN.z, step === 1 ? crossing : -99);

    // Sparks drawn into the box.
    const burst = step === 1 ? span(s2, 2.45, 3.25) : 0;
    this.sparks.visible = burst > 0 && burst < 1;
    if (this.sparks.visible) {
      const pos = this.sparks.geometry.getAttribute("position") as Float32BufferAttribute;
      const pull = 1 - easeIn(burst);
      for (let i = 0; i < SPARKS; i++) {
        const seed = this.sparkSeeds[i]!;
        const swirl = burst * 4 + i;
        pos.setXYZ(
          i,
          (seed.x * Math.cos(swirl) - seed.z * Math.sin(swirl)) * pull * 1.6,
          0.1 + seed.y * pull * 1.2,
          (seed.x * Math.sin(swirl) + seed.z * Math.cos(swirl)) * pull * 1.6
        );
      }
      pos.needsUpdate = true;
      (this.sparks.material as PointsMaterial).opacity = 1 - burst * 0.6;
    }

    // The key's tag: ciphertext once it is in, "matches" when the vault compares it in step 4.
    const tag = this.tags.key;
    const shown = step === 1 ? span(s2, 2.7, 3.1) : step === 2 ? 1 : step === 3 ? 1 - span(s4, 1.0, 1.4) : 0;
    tag.style.opacity = String(shown);
    const ok = step === 3 && s4 > 0.15;
    tag.classList.toggle("is-ok", ok);
    tag.textContent = ok ? `${this.labels.key} ✓ ${this.labels.keyOk}` : `${this.labels.key} ${scramble(8)}`;
  }

  private poseRoutes(step: number, s3: number, clock: number): void {
    const on = step === 2 ? window4(s3, 0, 0.5, 4.0, 4.55) : 0;
    this.orbit.visible = on > 0.001;
    this.orbit.rotation.y = clock * 0.22;
    (this.orbitRing.material as MeshBasicMaterial).opacity = 0.35 * on;
    const tmp = new Vector3();
    ROUTES.forEach((_, i) => {
      // Each way out lights up in turn as a packet reaches it.
      const start = ROUTE_START + i * ROUTE_GAP;
      const travel = span(s3, start, start + 0.45);
      const lit = window4(s3, start + 0.4, start + 0.5, start + 0.8, start + 1.15);
      const node = this.nodes[i]!;
      node.rotation.y = clock * 1.4 + i;
      node.scale.setScalar(on * (1 + lit * 0.5));
      (node.material as MeshBasicMaterial).opacity = on;
      this.routeTags[i]!.style.opacity = String(on * (0.55 + 0.45 * lit));
      this.routeTags[i]!.classList.toggle("is-lit", lit > 0.5);
      const packet = this.packets[i]!;
      packet.visible = step === 2 && travel > 0 && travel < 1;
      if (packet.visible) {
        node.getWorldPosition(tmp);
        packet.position.set(0, 0.1, 0).lerp(tmp, easeInOut(travel));
      }
    });

    // Probes fly in and bounce off the shield.
    const hits = this.glow.uniforms.uHits!.value as Vector4[];
    PROBES.forEach((p, i) => {
      const probe = this.probes[i]!;
      const age = step === 2 ? s3 - p.at : -1;
      const r = START - age * SPEED;
      const flying = age >= 0 && r > R;
      probe.dot.visible = probe.trail.visible = flying;
      const hitAt = p.at + (START - R) / SPEED;
      hits[i]!.set(p.dir.x, p.dir.y, p.dir.z, step === 2 ? 2 * STEP + hitAt : -99);
      if (flying) {
        const at = p.dir.clone().multiplyScalar(r);
        probe.dot.position.copy(at);
        const tail = p.dir.clone().multiplyScalar(Math.min(r + 0.7, START));
        const pos = probe.trail.geometry.getAttribute("position") as Float32BufferAttribute;
        pos.setXYZ(0, at.x, at.y, at.z);
        pos.setXYZ(1, tail.x, tail.y, tail.z);
        pos.needsUpdate = true;
      }
      probe.at.copy(p.dir).multiplyScalar(R * 1.08);
      const since = step === 2 ? s3 - hitAt : -1;
      probe.tag.style.opacity = String(since < 0 ? 0 : window4(since, 0, 0.12, 0.9, 1.3));
    });
  }

  private posePad(step: number, s4: number): void {
    const on = step === 3 ? window4(s4, 1.4, 1.9, 4.05, 4.55) : 0;
    const flash = step === 3 ? window4(s4, 3.2, 3.3, 3.3, 4.0) : 0;
    this.pad.visible = on > 0.001;
    this.pad.scale.setScalar(0.7 + 0.3 * on + flash * 0.15);
    this.padRing.opacity = on;
    this.padGlow.opacity = on * (0.45 + flash * 0.55);
    this.tags.fresh.style.opacity = String(on);
  }
}
