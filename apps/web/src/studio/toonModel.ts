import { BufferAttribute, Box3, Group, Mesh, MeshStandardMaterial, Vector3, type BufferGeometry, type Material, type Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { outlineMaterial, toon } from "@dno/scene";

/** What the studio puts on stage: built like the scene's own objects. */
export interface StageObject {
  group: Group;
  update(time: number): void;
  dispose(): void;
}

/** The height a generated model is scaled to, the size of a studio rat. */
const HEIGHT = 1.15;
const OUTLINE = "#17130F";

/**
 * Smooth normals for a mesh that came without any (the AI's meshes have positions and UVs only):
 * three.js's per-vertex normals, then averaged over every copy of a point, so the shading and the
 * outline do not split along the texture's seams. Without normals a toon material is all black and
 * the outline, pushed along them, falls apart.
 */
function smoothNormals(geometry: BufferGeometry): void {
  if (geometry.getAttribute("normal")) return;
  geometry.computeVertexNormals();
  const pos = geometry.getAttribute("position");
  const nor = geometry.getAttribute("normal") as BufferAttribute;
  const sums = new Map<string, [number, number, number]>();
  const keyOf = (i: number) => `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i);
    const s = sums.get(k) ?? [0, 0, 0];
    s[0] += nor.getX(i);
    s[1] += nor.getY(i);
    s[2] += nor.getZ(i);
    sums.set(k, s);
  }
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = sums.get(keyOf(i))!;
    v.set(x, y, z).normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  nor.needsUpdate = true;
}

/**
 * A model from the AI, dressed like the game's cats: each mesh gets a toon material over its
 * own colours (and texture, if it has one) and an inverted-hull outline, it is scaled to a
 * rat's height and stood on the floor. Generated meshes have no rig, so it lives as one block:
 * a slow breath and a little sway.
 */
export async function loadToonModel(url: string): Promise<StageObject> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  const owned: { dispose(): void }[] = [];

  const meshes: Mesh[] = [];
  model.traverse((o) => {
    if ((o as Mesh).isMesh) meshes.push(o as Mesh);
  });
  for (const mesh of meshes) {
    smoothNormals(mesh.geometry);
    const before = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material & { color?: { getHexString(): string }; map?: Texture | null };
    const standard = before as MeshStandardMaterial;
    const color = standard.map ? "#ffffff" : `#${before.color?.getHexString() ?? "e9dfc8"}`;
    const material = toon(color, standard.map ? { map: standard.map } : {});
    owned.push(material, mesh.geometry);
    mesh.material = material;
    mesh.castShadow = true;
  }

  // Scale first: the outline's thickness is in the model's own units.
  const size = new Box3().setFromObject(model).getSize(new Vector3());
  const scale = HEIGHT / Math.max(size.y, 1e-6);
  model.scale.setScalar(scale);
  for (const mesh of meshes) {
    const line = outlineMaterial(OUTLINE, 0.012 / scale);
    owned.push(line);
    const hull = new Mesh(mesh.geometry, line);
    hull.name = "outline";
    mesh.add(hull);
  }
  const box = new Box3().setFromObject(model);
  const centre = box.getCenter(new Vector3());
  model.position.set(-centre.x, -box.min.y, -centre.z);

  const body = new Group();
  body.add(model);
  const group = new Group();
  group.add(body);

  return {
    group,
    update(time: number) {
      const breath = Math.sin(time * 1.6);
      body.scale.set(1 + breath * 0.012, 1 + breath * 0.022, 1 + breath * 0.012);
      body.rotation.y = Math.sin(time * 0.35) * 0.18;
    },
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}
