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
  SRGBColorSpace,
  Texture,
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
  const hollow = new InstancedMesh(own(new PlaneGeometry(BW - 0.03, BD - 0.03)), mat(new MeshBasicMaterial({ color: "#1E140C" })), slots);
  // Open boxes: the front flap hangs down over the label, the back one stands up. Both read from the aisle.
  const flapMat = mat(new MeshLambertMaterial({ map: cardTex, side: DoubleSide }));
  const hangGeo = own(new PlaneGeometry(BW, BD / 2));
  hangGeo.translate(0, -BD / 4, 0);
  const standGeo = own(new PlaneGeometry(BW, BD / 2));
  standGeo.translate(0, BD / 4, 0);
  const flapsFront = new InstancedMesh(hangGeo, flapMat, slots);
  const flapsBack = new InstancedMesh(standGeo, flapMat, slots);
  const tags = new InstancedMesh(own(new PlaneGeometry(0.1, 0.16)), mat(new MeshBasicMaterial({ color: "#C2261D", side: DoubleSide })), slots);
  const parts = [bodies, tape, labels, stamps, hollow, flapsFront, flapsBack, tags];
  instanced.push(...parts);
  for (const m of parts) group.add(m);
  bodies.castShadow = quality.shadows;

  const hidden = new Matrix4().makeScale(0, 0, 0);
  const tint = new Color();
  const base = (tokenId: number) => tint.setHSL(0.08, 0.1, 0.72 + ((tokenId * 0.6180339) % 1) * 0.28);
  const place = (m: InstancedMesh, i: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(rx, ry, rz);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    m.setMatrixAt(i, dummy.matrix);
  };

  const states: { state: WarehouseBoxState; mine: boolean }[] = [];
  const draw = (tokenId: number) => {
    const { state, mine } = states[tokenId]!;
    const c = slotCentre(tokenId);
    const top = c.y + BH / 2;
    const front = c.z + BD / 2 + 0.003;
    place(bodies, tokenId, c.x, c.y, c.z);
    place(labels, tokenId, c.x - BW * 0.18, c.y + BH * 0.05, front);
    place(stamps, tokenId, c.x + BW * 0.22, c.y - BH * 0.22, front, 0, 0, -0.18);
    const open = state === "revealed";
    if (open) {
      tape.setMatrixAt(tokenId, hidden);
      place(hollow, tokenId, c.x, top + 0.002, c.z, -Math.PI / 2);
      place(flapsFront, tokenId, c.x, top, front + 0.004, -0.28);
      place(flapsBack, tokenId, c.x, top, c.z - BD / 2, -0.35);
    } else {
      place(tape, tokenId, c.x, top + 0.006, c.z);
      hollow.setMatrixAt(tokenId, hidden);
      flapsFront.setMatrixAt(tokenId, hidden);
      flapsBack.setMatrixAt(tokenId, hidden);
    }
    if (mine) place(tags, tokenId, c.x - BW / 2 + 0.07, c.y + BH * 0.18, front + 0.01, 0, 0, 0.2);
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
  const mark = (line: LineSegments, tokenId: number | null) => {
    line.visible = tokenId !== null && tokenId < count;
    if (line.visible) line.position.copy(slotCentre(tokenId!));
  };

  // Far enough back to take in the whole first row.
  const back = Math.max(8.5, halfWidth * 1.5);
  const bounds = {
    minX: -halfWidth - 2,
    maxX: halfWidth + 2,
    minZ: -(rows - 1) * ROW_GAP - 2,
    maxZ: back * 2.4,
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
    hover: (tokenId) => mark(hoverLine, tokenId),
    select: (tokenId) => mark(selectLine, tokenId),
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      for (const m of instanced) m.dispose();
    },
  };
}
