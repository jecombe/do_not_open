import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
  Texture,
  Vector2,
} from "three";
import { mulberry32 } from "@dno/generator";
import { QUALITY, type QualitySettings } from "../capability";
import { BOX_SIZE } from "../box/buildBox";
import { cardboardTexture, stampTexture, type TextureOptions } from "../box/textures";

export const DEPOT_COLORS = {
  shadow: "#17130F",
  concrete: "#3A352E",
  steel: "#4A4F55",
  bench: "#6B4A2E",
  sodium: "#FFC070",
  cold: "#5B7FA6",
} as const;

/** Height of the workbench top, where the hero box sits. */
export const BENCH_HEIGHT = 0.92;

export interface DepotObject {
  group: Group;
  /** Put the hero object in here: origin is the centre of the bench top. */
  benchAnchor: Group;
  update(time: number): void;
  dispose(): void;
}

/**
 * The mail room: concrete floor, a workbench under a hanging sodium lamp, and steel
 * shelving stacked with sealed boxes (one InstancedMesh for every box on the shelves).
 */
export function createDepot(quality: QualitySettings = QUALITY.high, opts: TextureOptions = {}): DepotObject {
  const group = new Group();
  group.name = "depot";
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];
  const rand = mulberry32(0xd0c5);

  const add = <T extends Object3D>(o: T, parent: Object3D = group) => {
    parent.add(o);
    return o;
  };
  const mesh = (geo: BufferGeometry, mat: Material, x = 0, y = 0, z = 0, parent: Object3D = group) => {
    geometries.push(geo);
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    return add(m, parent);
  };
  const lambert = (color: string) => {
    const m = new MeshLambertMaterial({ color });
    materials.push(m);
    return m;
  };

  // --- Floor ---
  const floorGeo = new PlaneGeometry(40, 40);
  floorGeo.rotateX(-Math.PI / 2);
  mesh(floorGeo, lambert(DEPOT_COLORS.concrete)).receiveShadow = true;

  // --- Workbench ---
  const wood = lambert(DEPOT_COLORS.bench);
  const top = mesh(new BoxGeometry(2.8, 0.08, 1.5), wood, 0, BENCH_HEIGHT - 0.04, 0);
  top.receiveShadow = true;
  top.castShadow = true;
  const steel = lambert(DEPOT_COLORS.steel);
  for (const [x, z] of [[-1.3, -0.65], [1.3, -0.65], [-1.3, 0.65], [1.3, 0.65]] as const) {
    mesh(new BoxGeometry(0.07, BENCH_HEIGHT - 0.08, 0.07), steel, x, (BENCH_HEIGHT - 0.08) / 2, z);
  }
  mesh(new BoxGeometry(2.6, 0.04, 1.3), wood, 0, 0.22, 0);
  const benchAnchor = add(new Group());
  benchAnchor.position.set(0, BENCH_HEIGHT, 0);

  // --- Hanging lamp ---
  const lamp = add(new Group());
  lamp.position.set(0.45, 3.9, 0.8);
  mesh(new CylinderGeometry(0.008, 0.008, 3, 4), steel, 0, 1.6, 0, lamp);
  const lampXZ = [0.45, 0.8] as const;
  const shadeGeo = new ConeGeometry(0.42, 0.26, 20, 1, true);
  const shadeMat = new MeshLambertMaterial({ color: "#2E3A34", side: DoubleSide });
  materials.push(shadeMat);
  mesh(shadeGeo, shadeMat, 0, 0.06, 0, lamp);
  const bulbMat = new MeshBasicMaterial({ color: "#FFE2B0" });
  materials.push(bulbMat);
  mesh(new SphereGeometry(0.07, 12, 10), bulbMat, 0, -0.02, 0, lamp);

  const spot = new SpotLight(DEPOT_COLORS.sodium, 30, 10, 0.6, 0.6, 1.6);
  spot.position.set(0.45, 3.85, 0.8);
  spot.target.position.set(0, BENCH_HEIGHT, 0);
  spot.castShadow = quality.shadows;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0008;
  spot.shadow.radius = 4;
  add(spot);
  add(spot.target);
  add(new HemisphereLight("#8496AD", "#2A2018", 0.9));
  const rim = new DirectionalLight(DEPOT_COLORS.cold, 0.9);
  rim.position.set(-4, 3, -5);
  add(rim);
  const fill = new DirectionalLight("#FFD9A8", 1.1);
  fill.position.set(2.5, 2, 5);
  add(fill);

  // --- Shelving with instanced boxes ---
  const shelfZ = -3.6;
  const bays = 5;
  const bayW = 2.6;
  const levels = [0.35, 1.45, 2.55, 3.65];
  for (let b = 0; b <= bays; b++) {
    const x = (b - bays / 2) * bayW;
    for (const z of [shelfZ - 0.55, shelfZ + 0.55]) mesh(new BoxGeometry(0.08, 4.6, 0.08), steel, x, 2.3, z);
  }
  for (const y of levels) mesh(new BoxGeometry(bays * bayW, 0.05, 1.2), steel, 0, y - 0.03, shelfZ);

  const cardTex = cardboardTexture(0xb0c5, 0.5, opts);
  const stampTex = stampTexture(0xb0c5, 0.6, opts);
  textures.push(cardTex, stampTex);
  const cardMat = new MeshLambertMaterial({ map: cardTex });
  const stampMat = new MeshBasicMaterial({ map: stampTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  materials.push(cardMat, stampMat);
  const boxGeo = new BoxGeometry(BOX_SIZE.width, BOX_SIZE.height, BOX_SIZE.depth);
  const stampGeo = new PlaneGeometry(0.62, 0.23);
  geometries.push(boxGeo, stampGeo);

  const count = quality.shelfBoxes;
  const boxes = new InstancedMesh(boxGeo, cardMat, count);
  const stamps = new InstancedMesh(stampGeo, stampMat, count);
  const m4 = new Matrix4();
  const dummy = new Object3D();
  const tint = new Color();
  let placed = 0;
  outer: for (const y of levels) {
    let x = (-bays * bayW) / 2 + 0.55;
    while (x < (bays * bayW) / 2 - 0.5) {
      if (placed >= count) break outer;
      // Leave gaps: some parcels were collected. Or left on their own.
      if (rand() < 0.22) {
        x += 0.5 + rand() * 0.8;
        continue;
      }
      const s = 0.55 + rand() * 0.3;
      const stacked = rand() < 0.25 && y < 3;
      for (let k = 0; k < (stacked ? 2 : 1) && placed < count; k++) {
        dummy.position.set(x, y + BOX_SIZE.height * s * (0.5 + k), shelfZ + (rand() - 0.5) * 0.2);
        dummy.rotation.set(0, (rand() - 0.5) * 0.5, 0);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        boxes.setMatrixAt(placed, dummy.matrix);
        boxes.setColorAt(placed, tint.setHSL(0.08, 0.05, 0.62 + rand() * 0.38));
        dummy.translateZ((BOX_SIZE.depth / 2) * s + 0.004);
        dummy.translateY((rand() - 0.5) * 0.2 * s);
        dummy.rotateZ((rand() - 0.5) * 0.5);
        dummy.updateMatrix();
        stamps.setMatrixAt(placed, m4.copy(dummy.matrix));
        placed++;
      }
      x += BOX_SIZE.width * s + 0.12 + rand() * 0.3;
    }
  }
  boxes.count = stamps.count = placed;
  boxes.instanceMatrix.needsUpdate = stamps.instanceMatrix.needsUpdate = true;
  if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
  add(boxes);
  add(stamps);

  // --- Dust drifting through the lamp cone ---
  const dustGeo = new BufferGeometry();
  const n = quality.dustCount;
  const pos = new Float32Array(n * 3);
  const phase = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(rand()) * 2.4;
    const a = rand() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 0.6 + rand() * 2.8;
    pos[i * 3 + 2] = Math.sin(a) * r + 0.2;
    phase[i] = rand() * 100;
  }
  dustGeo.setAttribute("position", new BufferAttribute(pos, 3));
  dustGeo.setAttribute("aPhase", new BufferAttribute(phase, 1));
  const dustMat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new Color("#FFD9A0") }, uScale: { value: 1 }, uLamp: { value: new Vector2(...lampXZ) } },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform float uTime;
      uniform float uScale;
      uniform vec2 uLamp;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float t = uTime * 0.12 + aPhase;
        p.x += sin(t * 1.3 + aPhase) * 0.25;
        p.z += cos(t * 1.1 + aPhase * 1.7) * 0.25;
        p.y = 0.6 + mod(p.y - 0.6 - uTime * 0.03 + aPhase * 0.02, 2.8);
        // Motes only catch light inside the lamp cone.
        float cone = smoothstep(1.9, 0.2, length(p.xz - uLamp) / max(0.2, (3.9 - p.y) * 0.7));
        vAlpha = cone * (0.35 + 0.65 * sin(t * 5.0 + aPhase) * 0.5 + 0.5);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uScale * (1.5 + fract(aPhase) * 2.5) * (6.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * vAlpha * 0.5);
      }`,
  });
  geometries.push(dustGeo);
  materials.push(dustMat);
  const dust = new Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  add(dust);

  return {
    group,
    benchAnchor,
    update(time) {
      dustMat.uniforms.uTime!.value = time;
      // The lamp swings a little, as if a door just closed somewhere.
      lamp.rotation.z = Math.sin(time * 0.7) * 0.015;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      boxes.dispose();
      stamps.dispose();
    },
  };
}
