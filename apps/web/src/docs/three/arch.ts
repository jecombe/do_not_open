import { BoxGeometry, BufferGeometry, CatmullRomCurve3, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, TubeGeometry, Vector3 } from "three";
import { outlineMaterial, toon } from "@dno/scene";
import { damp, PALETTE, Stage } from "./stage";
import { lookup } from "../i18n";

export interface ArchNode {
  id: string;
  name: string;
  /** "portable" sits on the top shelf, "chain" on the bottom one. */
  shelf: "portable" | "chain";
  slot: number;
  color: string;
  /** Not written yet: drawn as a wireframe. */
  ghost?: boolean;
}

/** What a crate holds, in the current language. */
export const archText = (id: string): string => lookup(`arch.${id}`) ?? id;

export const ARCH_NODES: ArchNode[] = [
  { id: "spec", name: "game-spec", shelf: "portable", slot: 0, color: PALETTE.manifest },
  { id: "generator", name: "generator", shelf: "portable", slot: 1, color: PALETTE.tape },
  { id: "scene", name: "scene", shelf: "portable", slot: 2, color: PALETTE.kraft },
  { id: "adapter", name: "ChainAdapter", shelf: "portable", slot: 3, color: PALETTE.sodium },
  { id: "web", name: "apps/web", shelf: "portable", slot: 4, color: PALETTE.red },
  { id: "contracts", name: "contracts-evm", shelf: "chain", slot: 0.5, color: PALETTE.cold },
  { id: "evm", name: "EvmFhevmAdapter", shelf: "chain", slot: 2, color: PALETTE.cold },
  { id: "solana", name: "SolanaAdapter", shelf: "chain", slot: 3.5, color: PALETTE.spectral, ghost: true },
];

/** from depends on to. */
export const ARCH_EDGES: [from: string, to: string][] = [
  ["generator", "spec"],
  ["scene", "generator"],
  ["web", "scene"],
  ["web", "adapter"],
  ["adapter", "spec"],
  ["contracts", "spec"],
  ["evm", "contracts"],
  ["evm", "adapter"],
  ["solana", "adapter"],
];

const SPACING = 1.5;
const SHELF_Y = { portable: 1.55, chain: 0 } as const;

interface Crate {
  node: ArchNode;
  group: Group;
  lift: number;
  dim: number;
  label: HTMLElement;
}

/**
 * The packages as crates on two shelves: what is portable on top, what belongs to one
 * chain underneath, and threads for who depends on whom.
 */
export class ArchScene {
  onHover: ((id: string | null) => void) | null = null;
  onSelect: ((id: string) => void) | null = null;

  private readonly stage: Stage;
  private readonly crates = new Map<string, Crate>();
  private readonly threads: { from: string; to: string; mesh: Mesh; glow: number }[] = [];
  private active: string | null = null;

  constructor(host: HTMLElement) {
    const stage = (this.stage = new Stage(host));
    stage.addGround(5, 1.6, -0.28);

    // Two planks.
    for (const shelf of ["portable", "chain"] as const) {
      const geo = new BoxGeometry(SPACING * 5 + 0.6, 0.1, 1.3);
      const plank = new Mesh(geo, toon(PALETTE.bench));
      plank.position.set(0, SHELF_Y[shelf] - 0.05, 0);
      plank.add(new Mesh(geo, outlineMaterial(PALETTE.ink, 0.012)));
      stage.scene.add(plank);
    }
    for (const x of [-1, 1]) {
      const geo = new BoxGeometry(0.1, SHELF_Y.portable + 1.3, 0.1);
      const post = new Mesh(geo, toon(PALETTE.steel));
      post.position.set(x * (SPACING * 2.5 + 0.25), (SHELF_Y.portable + 1.3) / 2 - 0.25, -0.55);
      stage.scene.add(post);
    }

    for (const node of ARCH_NODES) {
      const group = new Group();
      group.userData.pick = node.id;
      const geo = new BoxGeometry(1.05, 0.72, 0.82);
      if (node.ghost) {
        // Same wireframe language as a missing asset: the shape is known, the thing is not there.
        group.add(new LineSegments(new EdgesGeometry(geo), new LineBasicMaterial({ color: node.color })));
        const hit = new Mesh(geo, new MeshBasicMaterial({ transparent: true, opacity: 0.06, color: node.color, depthWrite: false }));
        group.add(hit);
      } else {
        const body = new Mesh(geo, toon(PALETTE.kraft));
        body.add(new Mesh(geo, outlineMaterial(PALETTE.ink, 0.014)));
        const band = new Mesh(new BoxGeometry(1.07, 0.16, 0.84), toon(node.color));
        band.position.y = 0.12;
        group.add(body, band);
      }
      group.position.set((node.slot - 2) * SPACING, SHELF_Y[node.shelf] + 0.36, 0);
      group.rotation.y = ((node.slot * 37) % 7) * 0.02 - 0.06;
      stage.scene.add(group);
      stage.pickables.push(group);
      const label = stage.addLabel("crate", new Vector3(0, 0.62, 0), group);
      label.textContent = node.name;
      this.crates.set(node.id, { node, group, lift: 0, dim: 0, label });
    }

    for (const [from, to] of ARCH_EDGES) {
      const a = this.crates.get(from)!.group.position;
      const b = this.crates.get(to)!.group.position;
      const mid = a.clone().lerp(b, 0.5);
      mid.z += 0.95;
      mid.y += a.y === b.y ? 0.55 : 0;
      const curve = new CatmullRomCurve3([a.clone().setZ(0.42), mid, b.clone().setZ(0.42)]);
      const ghost = this.crates.get(from)!.node.ghost;
      const mesh = new Mesh(new TubeGeometry(curve, 32, 0.016, 6), new MeshBasicMaterial({ color: ghost ? PALETTE.spectral : PALETTE.tape, transparent: true, opacity: 0.4, depthWrite: false }));
      stage.scene.add(mesh);
      this.threads.push({ from, to, mesh, glow: 0 });
    }

    stage.onHover = (id) => this.onHover?.(id);
    stage.onSelect = (id) => this.onSelect?.(id);
    stage.onLayout = (aspect) => {
      const narrow = aspect < 1.1;
      stage.frame(new Vector3(0, 1.05, 0), SPACING * 5 + 1.9, narrow ? 4.4 : 3.6, new Vector3(narrow ? 0 : 0.18, 0.3, 1));
    };
    stage.onLayout(stage.camera.aspect);
    stage.onFrame((_time, dt) => this.update(dt));
  }

  setActive(id: string | null): void {
    this.active = id;
    this.stage.wake();
  }

  dispose(): void {
    this.stage.dispose();
  }

  private update(dt: number): void {
    const rate = this.stage.reduced ? 60 : 8;
    const linked = new Set<string>();
    if (this.active) {
      linked.add(this.active);
      for (const t of this.threads) {
        if (t.from === this.active) linked.add(t.to);
        if (t.to === this.active) linked.add(t.from);
      }
    }
    for (const c of this.crates.values()) {
      c.lift = damp(c.lift, c.node.id === this.active ? 1 : 0, rate, dt);
      c.dim = damp(c.dim, this.active && !linked.has(c.node.id) ? 1 : 0, rate, dt);
      c.group.position.y = SHELF_Y[c.node.shelf] + 0.36 + c.lift * 0.16;
      c.group.scale.setScalar(1 - c.dim * 0.08);
      c.label.style.opacity = (1 - c.dim * 0.6).toFixed(2);
      c.label.classList.toggle("is-active", c.node.id === this.active);
    }
    for (const t of this.threads) {
      const lit = this.active !== null && (t.from === this.active || t.to === this.active);
      t.glow = damp(t.glow, lit ? 1 : 0, rate, dt);
      const mat = t.mesh.material as MeshBasicMaterial;
      mat.opacity = this.active ? 0.12 + t.glow * 0.88 : 0.4;
    }
  }
}
