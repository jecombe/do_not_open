import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  QuadraticBezierCurve3,
  RingGeometry,
  Vector3,
} from "three";
import { buildBoxSpec } from "@dno/generator";
import { createBox, outlineMaterial, toon } from "@dno/scene";
import { packetName, stationName, type FlowStep, type PacketKind, type StationId } from "../flows";
import { damp, PALETTE, Stage } from "./stage";

const PACKET_COLORS: Record<PacketKind, string> = {
  tx: PALETTE.tape,
  cipher: PALETTE.spectral,
  plain: PALETTE.manifest,
  proof: PALETTE.red,
  sign: PALETTE.sodium,
};

const POSITIONS: Record<StationId, [number, number]> = {
  you: [-2.9, 0.95],
  other: [-1.75, -1.5],
  contract: [0, 0],
  copro: [1.75, -1.5],
  kms: [2.9, 0.95],
};

/** How long a parcel takes to cross, in seconds. */
const TRAVEL = 1.5;

interface Station {
  id: StationId;
  group: Group;
  top: Vector3;
  pulse: number;
  ring: Mesh;
  label: HTMLElement;
  shown: number;
}

const outline = () => outlineMaterial(PALETTE.ink, 0.014);

function solid(w: number, h: number, d: number, color: string, y = h / 2): Mesh {
  const geo = new BoxGeometry(w, h, d);
  const mesh = new Mesh(geo, toon(color));
  mesh.position.y = y;
  mesh.add(new Mesh(geo, outline()));
  return mesh;
}

/** A desk with a paper slip on it: someone with a wallet. */
function desk(paper: string): Group {
  const g = new Group();
  g.add(solid(1.1, 0.5, 0.8, PALETTE.bench));
  const slip = solid(0.5, 0.03, 0.62, paper, 0.52);
  slip.rotation.y = 0.18;
  g.add(slip);
  const stamp = new Mesh(new BoxGeometry(0.2, 0.012, 0.1), new MeshBasicMaterial({ color: PALETTE.red }));
  stamp.position.set(0.04, 0.545, 0.12);
  stamp.rotation.y = 0.18;
  g.add(stamp);
  return g;
}

/** A steel cabinet with one glowing slit: it computes on things it cannot read. */
function cabinet(): Group {
  const g = new Group();
  g.add(solid(0.95, 1.15, 0.8, PALETTE.steel));
  for (let i = 0; i < 3; i++) {
    const slit = new Mesh(new BoxGeometry(0.6, 0.05, 0.02), new MeshBasicMaterial({ color: PALETTE.spectral }));
    slit.position.set(0, 0.45 + i * 0.22, 0.41);
    g.add(slit);
  }
  return g;
}

/** A safe: the key never leaves it, and no single party holds all of it. */
function safe(): Group {
  const g = new Group();
  g.add(solid(1.0, 1.0, 0.85, "#4A4038"));
  const dialGeo = new CylinderGeometry(0.2, 0.2, 0.06, 24);
  const dial = new Mesh(dialGeo, toon(PALETTE.sodium));
  dial.rotation.x = Math.PI / 2;
  dial.position.set(0, 0.55, 0.45);
  dial.add(new Mesh(dialGeo, outline()));
  g.add(dial);
  const handle = new Mesh(new BoxGeometry(0.06, 0.26, 0.05), toon(PALETTE.manifest));
  handle.position.set(0.32, 0.55, 0.45);
  g.add(handle);
  return g;
}

/**
 * The parties of a flow as objects on a dock, and one parcel that carries each step
 * from one to the other. The parcel's colour says what kind of thing is travelling.
 */
export class FlowScene {
  private readonly stage: Stage;
  private readonly stations = new Map<StationId, Station>();
  private readonly packet: Mesh;
  private readonly packetLabel: HTMLElement;
  private readonly trail: Line;
  private readonly curve = new QuadraticBezierCurve3();
  private step: FlowStep | null = null;
  private progress = 1;
  private used = new Set<StationId>(["you", "contract", "copro", "kms"]);

  constructor(host: HTMLElement) {
    const stage = (this.stage = new Stage(host));
    stage.addGround(4.6, 2.9, -0.02);

    const builders: Record<StationId, () => { group: Group; height: number }> = {
      you: () => ({ group: desk(PALETTE.manifest), height: 0.6 }),
      other: () => ({ group: desk(PALETTE.tape), height: 0.6 }),
      contract: () => {
        const box = createBox(buildBoxSpec(42));
        return { group: box.group, height: 0.95 };
      },
      copro: () => ({ group: cabinet(), height: 1.2 }),
      kms: () => ({ group: safe(), height: 1.05 }),
    };

    for (const id of Object.keys(POSITIONS) as StationId[]) {
      const { group, height } = builders[id]();
      const [x, z] = POSITIONS[id];
      group.position.set(x, 0, z);
      group.rotation.y = id === "contract" ? -0.3 : x < 0 ? 0.22 : -0.22;
      stage.scene.add(group);
      const ring = new Mesh(new RingGeometry(0.75, 0.8, 48), new MeshBasicMaterial({ color: PALETTE.sodium, transparent: true, opacity: 0, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.01, z);
      stage.scene.add(ring);
      const label = stage.addLabel("station", new Vector3(x, -0.22, z + 0.62));
      label.textContent = stationName(id);
      this.stations.set(id, { id, group, top: new Vector3(x, height, z), pulse: 0, ring, label, shown: 1 });
    }

    const geo = new BoxGeometry(0.26, 0.2, 0.22);
    this.packet = new Mesh(geo, toon(PALETTE.tape));
    this.packet.add(new Mesh(geo, outline()));
    this.packet.visible = false;
    stage.scene.add(this.packet);
    this.packetLabel = stage.addLabel("packet", new Vector3(0, 0.34, 0), this.packet);

    this.trail = new Line(new BufferGeometry(), new LineDashedMaterial({ color: PALETTE.tape, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.7 }));
    this.trail.visible = false;
    stage.scene.add(this.trail);

    stage.onLayout = (aspect) => {
      const narrow = aspect < 1.1;
      stage.frame(new Vector3(0, 0.7, -0.2), narrow ? 9.1 : 8.3, narrow ? 5.6 : 4.8, new Vector3(0, narrow ? 1.0 : 0.55, 1));
    };
    stage.onLayout(stage.camera.aspect);
    stage.onFrame((time, dt) => this.update(time, dt));
  }

  /** Rewrites the station labels, after a language change. */
  relabel(): void {
    for (const s of this.stations.values()) s.label.textContent = stationName(s.id);
    if (this.step) this.packetLabel.textContent = packetName(this.step.kind);
  }

  /** Which parties this flow involves. The others step back into the dark. */
  setParties(ids: StationId[]): void {
    this.used = new Set(ids);
    this.stage.wake();
  }

  /** Plays one step. `null` clears the dock. */
  setStep(step: FlowStep | null): void {
    this.step = step;
    this.progress = this.stage.reduced ? 1 : 0;
    this.packet.visible = false;
    this.trail.visible = false;
    this.packetLabel.textContent = "";
    if (!step) return;

    const color = PACKET_COLORS[step.kind];
    (this.packet.material as ReturnType<typeof toon>).color.set(color);
    (this.trail.material as LineDashedMaterial).color.set(color);
    const from = this.stations.get(step.from)!;
    const to = this.stations.get(step.to)!;
    this.packetLabel.textContent = packetName(step.kind);
    this.packetLabel.style.setProperty("--packet", color);

    if (step.from === step.to) {
      // Something a party does alone: the parcel rises out of it and the floor lights up.
      from.pulse = 1;
      this.curve.v0.copy(from.top);
      this.curve.v1.copy(from.top).setY(from.top.y + 0.9);
      this.curve.v2.copy(from.top).setY(from.top.y + 0.45);
    } else {
      this.curve.v0.copy(from.top);
      this.curve.v2.copy(to.top);
      this.curve.v1.copy(from.top).lerp(to.top, 0.5).setY(Math.max(from.top.y, to.top.y) + 1.35);
      this.trail.geometry.dispose();
      this.trail.geometry = new BufferGeometry().setFromPoints(this.curve.getPoints(40));
      this.trail.computeLineDistances();
      this.trail.visible = true;
      to.pulse = this.stage.reduced ? 1 : 0;
    }
    this.packet.visible = true;
    this.stage.wake();
  }

  dispose(): void {
    this.stage.dispose();
  }

  private update(time: number, dt: number): void {
    if (this.step && this.progress < 1) {
      this.progress = Math.min(1, this.progress + dt / TRAVEL);
      if (this.progress === 1 && this.step.from !== this.step.to) this.stations.get(this.step.to)!.pulse = 1;
    }
    if (this.step) {
      // Ease in and out so the parcel leaves and lands softly.
      const p = this.progress;
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      this.curve.getPoint(e, this.packet.position);
      this.packet.rotation.y = time * 1.4;
      this.packet.rotation.z = Math.sin(e * Math.PI) * 0.35;
      // A ciphertext never looks the same twice.
      const flicker = this.step.kind === "cipher" && !this.stage.reduced ? 0.86 + 0.14 * Math.sin(time * 38) : 1;
      this.packet.scale.setScalar(flicker);
    }
    for (const s of this.stations.values()) {
      s.pulse = damp(s.pulse, 0, 1.6, dt);
      const mat = s.ring.material as MeshBasicMaterial;
      mat.opacity = s.pulse * 0.9;
      s.ring.scale.setScalar(1 + (1 - s.pulse) * 0.35);
      s.shown = damp(s.shown, this.used.has(s.id) ? 1 : 0, this.stage.reduced ? 60 : 6, dt);
      s.group.scale.setScalar(0.001 + s.shown * 0.999);
      s.group.visible = s.shown > 0.02;
      s.label.style.opacity = s.shown.toFixed(2);
    }
  }
}
