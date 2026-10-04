import { Box3, Group, Mesh, MeshStandardMaterial, Vector3, type Material, type Texture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { outlineMaterial, toon } from "@dno/scene";

/** What the studio puts on stage: built like the scene's own objects. */
export interface StageObject {
  group: Group;
  update(time: number): void;
  dispose(): void;
}

/** The height a generated model is scaled to, the size of a sitting game cat. */
const HEIGHT = 1.15;
const OUTLINE = "#17130F";

/**
 * A model from the AI, dressed like the game's cats: each mesh gets a toon material over its
 * own colours (and texture, if it has one) and an inverted-hull outline, it is scaled to a
 * cat's height and stood on the floor. Generated meshes have no rig, so it lives as one block:
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
