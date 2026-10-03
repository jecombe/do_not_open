import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Texture,
  Euler,
  Vector3,
} from "three";
import { buildBoxSpec } from "@dno/generator";
import { QUALITY, type QualitySettings } from "../capability";
import { BOX_SIZE } from "../box/buildBox";
import { cardboardTexture, stampTexture, type TextureOptions } from "../box/textures";
import { DEPOT_COLORS } from "./buildDepot";

/** Boxes per rack: four levels of six. Rack k holds tokens 24k to 24k + 23, read top-left first. */
export const RACK_LEVELS = 4;
export const RACK_SLOTS = 6;
export const RACK_CAPACITY = RACK_LEVELS * RACK_SLOTS;
const RACKS_PER_ROW = 4;

const SCALE = 0.62;
const SLOT_W = 0.9;
const RACK_W = SLOT_W * RACK_SLOTS;
const RACK_D = 0.8;
const RACK_GAP = 1.4;
const ROW_GAP = 4.2;
/** Height of each shelf's top surface, bottom level first. */
const SHELF_Y = [0.14, 1.12, 2.1, 3.08];
const RACK_H = 3.75;

const BW = BOX_SIZE.width * SCALE;
const BH = BOX_SIZE.height * SCALE;
const BD = BOX_SIZE.depth * SCALE;
/** How thick an opened box is once crushed flat. */
const FLAT = 0.05;

export type WarehouseBoxState = "sealed" | "opening" | "revealed";

export interface WarehouseObject {
  group: Group;
  /** Raycast this one: its instance id is the token id. */
  bodies: InstancedMesh;
  /** Centre of a box, in the warehouse's space. */
  positionOf(tokenId: number): Vector3;
  /** Where a visitor may walk: x and z limits of the floor between the racks. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Where a visitor starts, and what they look at. */
  entrance: { position: Vector3; target: Vector3 };
  setState(tokenId: number, state: WarehouseBoxState, mine: boolean): void;
  hover(tokenId: number | null): void;
  select(tokenId: number | null): void;
  /** Moves the hovered and selected boxes: call once per frame. */
  update(time: number, dt: number): void;
  dispose(): void;
}

/** A small sign above each rack naming the boxes it holds. */
function rackSign(rack: number, count: number, opts: TextureOptions): CanvasTexture {
  const canvas = opts.createCanvas?.(512, 96) ?? Object.assign(document.createElement("canvas"), { width: 512, height: 96 });
  const g = canvas.getContext("2d")! as CanvasRenderingContext2D;
  g.fillStyle = "#E9DFC8";
  g.fillRect(0, 0, 512, 96);
  g.strokeStyle = "#1C1814";
  g.lineWidth = 6;
  g.strokeRect(3, 3, 506, 90);
  const first = buildBoxSpec(rack * RACK_CAPACITY).serial;
  const last = buildBoxSpec(rack * RACK_CAPACITY + Math.max(0, count - 1)).serial;
  g.fillStyle = "#1C1814";
  g.font = "700 46px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(count > 1 ? `${first} – ${last.slice(4)}` : count === 1 ? first : "—", 256, 50);
  const tex = new CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * The warehouse: every minted box on steel racks, rows of four racks with aisles between.
 * One InstancedMesh per part (bodies, tape, labels, flaps…) so thousands of boxes stay cheap.
 */
export function createWarehouse(count: number, quality: QualitySettings = QUALITY.high, opts: TextureOptions = {}): WarehouseObject {
  const group = new Group();
  group.name = "warehouse";
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];
  const instanced: InstancedMesh[] = [];
  const own = <T extends BufferGeometry>(g: T) => (geometries.push(g), g);
  const mat = <T extends Material>(m: T) => (materials.push(m), m);

  const racks = Math.max(1, Math.ceil(count / RACK_CAPACITY));
  const rows = Math.ceil(racks / RACKS_PER_ROW);
  const cols = Math.min(racks, RACKS_PER_ROW);
  const halfWidth = ((cols - 1) / 2) * (RACK_W + RACK_GAP) + RACK_W / 2;

  // Rows are centred on the racks there are, so a small collection is not off to one side.
  const rackOrigin = (rack: number) => {
    const row = Math.floor(rack / RACKS_PER_ROW);
    const col = rack % RACKS_PER_ROW;
    return new Vector3((col - (cols - 1) / 2) * (RACK_W + RACK_GAP), 0, -row * ROW_GAP);
  };
  const slotCentre = (tokenId: number) => {
    const rack = Math.floor(tokenId / RACK_CAPACITY);
    const k = tokenId % RACK_CAPACITY;
    const level = RACK_LEVELS - 1 - Math.floor(k / RACK_SLOTS);
    const slot = k % RACK_SLOTS;
    const o = rackOrigin(rack);
    return new Vector3(o.x + (slot - (RACK_SLOTS - 1) / 2) * SLOT_W, SHELF_Y[level]! + BH / 2, o.z);
  };

  // --- Floor, painted aisle lines and light ---
  const floorW = halfWidth * 2 + 10;
  const floorD = rows * ROW_GAP + 14;
  const floorGeo = own(new PlaneGeometry(floorW, floorD));
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new Mesh(floorGeo, mat(new MeshLambertMaterial({ color: DEPOT_COLORS.concrete })));
  floor.position.z = -(rows - 1) * ROW_GAP * 0.5 + 2;
  floor.receiveShadow = true;
  group.add(floor);

  const lineGeo = own(new PlaneGeometry(halfWidth * 2 + 1, 0.08));
  lineGeo.rotateX(-Math.PI / 2);
  const lineMat = mat(new MeshBasicMaterial({ color: "#C9A43A", transparent: true, opacity: 0.55 }));
  for (let r = 0; r < rows; r++) {
    const line = new Mesh(lineGeo, lineMat);
    line.position.set(0, 0.003, -r * ROW_GAP + RACK_D / 2 + 0.5);
    group.add(line);
  }

  group.add(new HemisphereLight("#AFC0D6", "#3A2C20", 2.2));
  const key = new DirectionalLight(DEPOT_COLORS.sodium, 2.4);
  key.position.set(3, 8, 6);
  group.add(key);
  const front = new DirectionalLight("#FFE6C4", 1.2);
  front.position.set(-2, 3, 10);
  group.add(front);
  const rim = new DirectionalLight(DEPOT_COLORS.cold, 0.7);
  rim.position.set(-6, 4, -8);
  group.add(rim);

  // Sodium lamps hanging over each aisle: emissive only, no extra lights.
  const lampGeo = own(new BoxGeometry(1.4, 0.06, 0.18));
  const lampMat = mat(new MeshBasicMaterial({ color: "#FFE2B0" }));
  const lamps = new InstancedMesh(lampGeo, lampMat, rows * cols);
  instanced.push(lamps);
  const dummy = new Object3D();
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const o = rackOrigin(r * RACKS_PER_ROW + c);
      dummy.position.set(o.x, 4.6, o.z + ROW_GAP / 2);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      lamps.setMatrixAt(n++, dummy.matrix);
    }
  }
  group.add(lamps);

  // --- Racks: four posts and four shelves each, plus a sign ---
  const steel = mat(new MeshLambertMaterial({ color: DEPOT_COLORS.steel }));
  const posts = new InstancedMesh(own(new BoxGeometry(0.06, RACK_H, 0.06)), steel, racks * 4);
  const shelves = new InstancedMesh(own(new BoxGeometry(RACK_W + 0.1, 0.04, RACK_D)), steel, racks * RACK_LEVELS);
  instanced.push(posts, shelves);
  const signGeo = own(new PlaneGeometry(1.5, 0.28));
  for (let k = 0; k < racks; k++) {
    const o = rackOrigin(k);
    let p = 0;
    for (const dx of [-RACK_W / 2 - 0.02, RACK_W / 2 + 0.02]) {
      for (const dz of [-RACK_D / 2, RACK_D / 2]) {
        dummy.position.set(o.x + dx, RACK_H / 2, o.z + dz);
        dummy.updateMatrix();
        posts.setMatrixAt(k * 4 + p++, dummy.matrix);
      }
    }
    SHELF_Y.forEach((y, l) => {
      dummy.position.set(o.x, y - 0.02, o.z);
      dummy.updateMatrix();
      shelves.setMatrixAt(k * RACK_LEVELS + l, dummy.matrix);
    });
    const tex = rackSign(k, Math.min(RACK_CAPACITY, count - k * RACK_CAPACITY), opts);
    textures.push(tex);
    const sign = new Mesh(signGeo, mat(new MeshBasicMaterial({ map: tex })));
    sign.position.set(o.x, RACK_H + 0.2, o.z + RACK_D / 2);
    group.add(sign);
  }
  group.add(posts, shelves);

  // --- Boxes: a body per token, then what is on it depends on its state ---
  const cardTex = cardboardTexture(0x5a1e, 0.45, opts);
  const stampTex = stampTexture(0x5a1e, 0.5, opts);
  textures.push(cardTex, stampTex);
  const slots = Math.max(1, count);
  const bodyMat = mat(new MeshLambertMaterial({ map: cardTex }));
  const bodies = new InstancedMesh(own(new BoxGeometry(BW, BH, BD)), bodyMat, slots);
  const tape = new InstancedMesh(own(new BoxGeometry(0.2 * SCALE, 0.012, BD + 0.01)), mat(new MeshLambertMaterial({ color: "#D9C28A" })), slots);
  const labels = new InstancedMesh(own(new PlaneGeometry(0.36 * SCALE, 0.24 * SCALE)), mat(new MeshLambertMaterial({ color: "#EFE8D6" })), slots);
  const stamps = new InstancedMesh(
    own(new PlaneGeometry(0.5 * SCALE, 0.18 * SCALE)),
    mat(new MeshBasicMaterial({ map: stampTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })),
    slots,
  );
  const tags = new InstancedMesh(own(new PlaneGeometry(0.1, 0.16)), mat(new MeshBasicMaterial({ color: "#C2261D", side: DoubleSide })), slots);
  const parts = [bodies, tape, labels, stamps, tags];
  instanced.push(...parts);
  for (const m of parts) group.add(m);
  bodies.castShadow = quality.shadows;

  const hidden = new Matrix4().makeScale(0, 0, 0);
  const tint = new Color();
  const base = (tokenId: number) => tint.setHSL(0.08, 0.1, 0.72 + ((tokenId * 0.6180339) % 1) * 0.28);
  // Each part is placed relative to its box's centre, then carried by the box's pose:
  // at rest on the shelf, or lifted and rocking when hovered or picked.
  const boxMatrix = new Matrix4();
  const partMatrix = new Matrix4();
  const poseQ = new Quaternion();
  const poseE = new Euler();
  const one = new Vector3(1, 1, 1);
  const place = (m: InstancedMesh, i: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sy = 1, sxz = 1) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(rx, ry, rz);
    dummy.scale.set(sxz, sy, sxz);
    dummy.updateMatrix();
    m.setMatrixAt(i, partMatrix.multiplyMatrices(boxMatrix, dummy.matrix));
  };

  const states: { state: WarehouseBoxState; mine: boolean }[] = [];
  /** How a box sits right now: lifted `y`, pulled out `z`, tipped `rx`/`rz`, turned `ry`. */
  interface Pose {
    y: number;
    z: number;
    rx: number;
    ry: number;
    rz: number;
  }
  const REST: Pose = { y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
  const poses = new Map<number, Pose>();
  const poseMatrix = (tokenId: number, out: Matrix4) => {
    const c = slotCentre(tokenId);
    const p = poses.get(tokenId) ?? REST;
    // Rocks about the bottom edge, like a box lifted by one hand: pivot under the centre.
    poseQ.setFromEuler(poseE.set(p.rx, p.ry, p.rz));
    out.compose(new Vector3(c.x, c.y + p.y - BH / 2, c.z + p.z), poseQ, one);
    return out.multiply(partMatrix.makeTranslation(0, BH / 2, 0));
  };

  const draw = (tokenId: number) => {
    const { state, mine } = states[tokenId]!;
    poseMatrix(tokenId, boxMatrix);
    const top = BH / 2;
    const front = BD / 2 + 0.003;
    const open = state === "revealed";
    // Once opened, the cat is out and the box was crushed flat: the flattened carton is what is left.
    if (open) {
      place(bodies, tokenId, 0, -BH / 2 + FLAT / 2, 0, 0, 0, 0, FLAT / BH, 1.1);
      labels.setMatrixAt(tokenId, hidden);
      tape.setMatrixAt(tokenId, hidden);
      // The stamp, lying face up on the flattened carton.
      place(stamps, tokenId, 0, -BH / 2 + FLAT + 0.003, 0, -Math.PI / 2, 0, -0.18);
    } else {
      place(bodies, tokenId, 0, 0, 0);
      place(labels, tokenId, -BW * 0.18, BH * 0.05, front);
      place(stamps, tokenId, BW * 0.22, -BH * 0.22, front, 0, 0, -0.18);
      place(tape, tokenId, 0, top + 0.006, 0);
    }
    if (mine) place(tags, tokenId, -BW / 2 + 0.07, open ? -BH / 2 + FLAT + 0.06 : BH * 0.18, front + 0.01, 0, 0, 0.2);
    else tags.setMatrixAt(tokenId, hidden);
    // An opening in progress is lit up a little, like a box someone is working on.
    bodies.setColorAt(tokenId, state === "opening" ? tint.set("#FFD39A") : base(tokenId));
  };

  for (let i = 0; i < slots; i++) {
    states.push({ state: "sealed", mine: false });
    if (i < count) draw(i);
    else for (const m of parts) m.setMatrixAt(i, hidden);
  }
  const touch = () => {
    for (const m of parts) m.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  };
  touch();
  bodies.computeBoundingSphere();

  // --- Hover and selection: an outline around the box ---
  const edges = own(new EdgesGeometry(new BoxGeometry(BW + 0.05, BH + 0.05, BD + 0.05)));
  const outline = (color: string) => {
    const l = new LineSegments(edges, mat(new LineBasicMaterial({ color })));
    l.visible = false;
    group.add(l);
    return l;
  };
  const hoverLine = outline("#E9DFC8");
  const selectLine = outline("#FFB454");
  const marked = new Map<LineSegments, number | null>();
  const mark = (line: LineSegments, tokenId: number | null) => {
    const id = tokenId !== null && tokenId < count ? tokenId : null;
    marked.set(line, id);
    line.visible = id !== null;
    line.matrixAutoUpdate = false;
    if (id !== null) poseMatrix(id, line.matrix);
  };

  // --- Lifting: a hovered box rises a little; the picked one is pulled out, rocks, and floats ---
  let hovered: number | null = null;
  let selected: number | null = null;
  /** 0 at rest, 1 fully lifted; and when it was picked, for the wobble. */
  const lifts = new Map<number, { k: number; since: number }>();
  let clock = 0;
  const HOVER_LIFT = 0.35;
  const lift = (tokenId: number | null) => {
    if (tokenId === null || tokenId >= count) return;
    if (!lifts.has(tokenId)) lifts.set(tokenId, { k: 0, since: clock });
  };
  const liftGoal = (tokenId: number) => (tokenId === selected ? 1 : tokenId === hovered ? HOVER_LIFT : 0);

  // Far enough back to take in the whole first row.
  const back = Math.max(8.5, halfWidth * 1.5);
  const bounds = {
    minX: -halfWidth - 2,
    maxX: halfWidth + 2,
    minZ: -(rows - 1) * ROW_GAP - 2,
    // The door, and a little room behind it: a narrow screen enters from up to 1.9 times as far back.
    maxZ: back * 2,
  };
  const entrance = { position: new Vector3(0, 2.4, back), target: new Vector3(0, 1.8, 0) };

  return {
    group,
    bodies,
    positionOf: slotCentre,
    bounds,
    entrance,
    setState(tokenId, state, mine) {
      if (tokenId >= count) return;
      const s = states[tokenId]!;
      if (s.state === state && s.mine === mine) return;
      states[tokenId] = { state, mine };
      draw(tokenId);
      touch();
    },
    hover(tokenId) {
      hovered = tokenId;
      lift(tokenId);
      mark(hoverLine, tokenId);
    },
    select(tokenId) {
      selected = tokenId;
      lift(tokenId);
      // A fresh pick rocks again, even if it was already up.
      if (tokenId !== null && lifts.has(tokenId)) lifts.get(tokenId)!.since = clock;
      mark(selectLine, tokenId);
    },
    update(time, dt) {
      clock = time;
      if (!lifts.size) return;
      const step = Math.min(dt, 0.1);
      for (const [id, l] of lifts) {
        const goal = liftGoal(id);
        l.k = goal + (l.k - goal) * Math.exp(-9 * step);
        if (goal === 0 && l.k < 0.002) {
          lifts.delete(id);
          poses.delete(id);
        } else {
          const since = time - l.since;
          const picked = id === selected;
          // A few quick rocks when picked, settling into a slow float.
          const rock = picked ? Math.sin(since * 13) * 0.09 * Math.exp(-since * 2.6) : 0;
          const float = picked ? Math.sin(time * 2.4) : 0;
          poses.set(id, {
            y: l.k * 0.13 + float * 0.012,
            z: l.k * 0.26,
            rx: -l.k * 0.06 + float * 0.01,
            ry: rock * 0.6 + (picked ? Math.sin(time * 1.3) * 0.03 : 0),
            rz: rock,
          });
        }
        draw(id);
      }
      touch();
      for (const [line, id] of marked) if (id !== null) poseMatrix(id, line.matrix);
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      for (const m of instanced) m.dispose();
    },
  };
}
