import { BufferGeometry, Group, Material, Mesh, MeshStandardMaterial, Object3D } from "three";
import type { CatBody } from "@dno/generator";
import { AssetLibrary, CAT_BREEDS } from "../assets/gltf";
import type { Kit } from "../materials";

export type CatBreed = (typeof CAT_BREEDS)[number];

let library: AssetLibrary | null = null;

/** The library cats load their kit from. Created on first use with the default paths. */
export function catAssetLibrary(): AssetLibrary {
  return (library ??= new AssetLibrary());
}

/** Points cats at another library, for example one with a different base URL. */
export function setCatAssetLibrary(next: AssetLibrary): void {
  library = next;
}

const PATTERN_BREED: Partial<Record<CatBody["pattern"], CatBreed>> = {
  tuxedo: "tuxedo",
  calico: "calico",
  points: "siamese",
  solid: "void",
  hairless: "sphynx",
  loaf: "loaf",
  glitch: "glitch",
};

/**
 * Which breed's meshes draw a body. The first form of a cat is its breed trait. The
 * second form of a quantum cat only exists as a CatBody, which does not name its breed,
 * so it is recognised by its look; tabby and orange share every field but the colour.
 */
export function breedOf(body: CatBody, trait?: string): CatBreed {
  if (trait && (CAT_BREEDS as readonly string[]).includes(trait)) return trait as CatBreed;
  const byPattern = PATTERN_BREED[body.pattern];
  if (byPattern) return byPattern;
  if (body.mane) return "maineCoon";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(body.furBase.slice(i, i + 2), 16));
  const max = Math.max(r!, g!, b!);
  return max > 0 && (max - Math.min(r!, g!, b!)) / max > 0.6 ? "orange" : "tabby";
}

const prepared = new WeakSet<Object3D>();

/** One-off fix-ups on a freshly loaded kit file. */
export function prepareKit(root: Object3D): Object3D {
  if (prepared.has(root)) return root;
  prepared.add(root);
  root.traverse((o) => {
    const geometry = (o as Mesh).geometry as BufferGeometry | undefined;
    if (!geometry) return;
    // glTF can only carry the zone masks as a vertex colour. Rename it so no material tints with it.
    const color = geometry.getAttribute("color");
    if (color) {
      geometry.setAttribute("zone", color);
      geometry.deleteAttribute("color");
    }
    geometry.computeBoundingBox();
  });
  return root;
}

export const isPlaceholder = (root: Object3D) => root.name === "placeholder";

export function find(root: Object3D, name: string): Object3D {
  const o = root.getObjectByName(name);
  if (!o) throw new Error(`cat kit has no "${name}"`);
  return o;
}

/** A group sitting exactly where a kit anchor is. */
export function anchored(parent: Object3D, anchor: Object3D): Group {
  const g = new Group();
  g.position.copy(anchor.position);
  g.quaternion.copy(anchor.quaternion);
  g.scale.copy(anchor.scale);
  parent.add(g);
  return g;
}

export interface PartOptions {
  /** Material name -> colour. Names not listed keep the colour they were exported with. */
  colors?: Record<string, string>;
  /** Replaces every opaque material, whatever its name. */
  override?: Material;
  thickness?: number;
}

/** Instantiates a kit part: one mesh per material, sharing the kit's geometry. */
export function addPart(kit: Kit, parent: Object3D, part: Object3D, opts: PartOptions = {}): Group {
  const g = new Group();
  parent.add(g);
  for (const child of part.children) {
    const src = child as Mesh;
    if (!src.isMesh) continue;
    const srcMat = src.material as MeshStandardMaterial;
    const flags = src.userData as { outline?: number; flat?: number; opacity?: number };
    const opacity = flags.opacity ?? 1;
    const color = opts.colors?.[srcMat.name] ?? `#${srcMat.color.getHexString()}`;
    const material =
      opts.override && opacity >= 1 ? opts.override : flags.flat || opacity < 1 ? kit.flat(color, { opacity }) : kit.fur(color);
    kit.add(g, src.geometry, material, {
      outline: !!flags.outline,
      shadow: kit.mode === "toon" && !!flags.outline,
      shared: true,
      thickness: opts.thickness,
    });
  }
  return g;
}
