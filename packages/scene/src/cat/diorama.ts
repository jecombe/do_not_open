import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Material,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  Vector2,
} from "three";
import type { CatSpec } from "@dno/generator";
import { Kit } from "../materials";
import { createCat, type CatObject } from "./buildCat";

function puddle(kit: Kit, parent: Object3D, color: string, radius: number, x: number, z: number) {
  const geo = new CircleGeometry(radius, 20);
  geo.rotateX(-Math.PI / 2);
  geo.scale(1.3, 1, 0.85);
  kit.add(parent, geo, kit.flat(color, { opacity: 0.85 }), { outline: false, shadow: false }).position.set(x, 0.006, z);
}

function shards(kit: Kit, parent: Object3D, color: string, count: number, spread: number) {
  for (let i = 0; i < count; i++) {
    const a = i * 2.4;
    const shard = kit.add(parent, new TetrahedronGeometry(0.035 + (i % 3) * 0.012), kit.fur(color));
    shard.position.set(Math.cos(a) * spread * (0.5 + (i % 4) * 0.2), 0.02, Math.sin(a) * spread * (0.5 + (i % 3) * 0.25));
    shard.rotation.set(a, a * 1.7, a * 0.6);
  }
}

const twoSided = (mesh: Mesh) => {
  (mesh.material as Material).side = DoubleSide;
};

const lathe = (points: [number, number][], segments = 16) =>
  new LatheGeometry(points.map(([x, y]) => new Vector2(x, y)), segments);

/** The thing the cat broke, lying on the floor. Origin at floor level. */
export function buildBrokenThing(kit: Kit, key: string): Group {
  const g = new Group();
  switch (key) {
    case "nothing":
      break;
    case "mug": {
      const mug = new Group();
      mug.position.y = 0.1;
      mug.rotation.z = Math.PI / 2;
      g.add(mug);
      twoSided(kit.add(mug, new CylinderGeometry(0.1, 0.09, 0.22, 16, 1, true), kit.fur("#E8E0D0")));
      const handle = new TorusGeometry(0.06, 0.018, 6, 12, Math.PI);
      handle.rotateZ(-Math.PI / 2);
      kit.add(mug, handle, kit.fur("#E8E0D0")).position.set(0.1, 0, 0);
      puddle(kit, g, "#4A2C17", 0.2, 0.22, 0.05);
      shards(kit, g, "#E8E0D0", 3, 0.25);
      break;
    }
    case "vase": {
      const base = lathe([[0, 0], [0.09, 0], [0.13, 0.08], [0.12, 0.17], [0.08, 0.2], [0.11, 0.24], [0.06, 0.21]]);
      twoSided(kit.add(g, base, kit.fur("#3F7CAC")));
      shards(kit, g, "#3F7CAC", 6, 0.3);
      puddle(kit, g, "#9CC8E0", 0.22, 0.1, 0.12);
      for (let i = 0; i < 3; i++) {
        const stem = new CylinderGeometry(0.008, 0.008, 0.34, 4);
        stem.rotateZ(Math.PI / 2);
        const s = kit.add(g, stem, kit.fur("#4C8C4A"), { outline: false });
        s.position.set(0.24, 0.015, 0.1 + i * 0.07);
        s.rotation.y = -0.3 + i * 0.3;
        const bloom = kit.add(g, new SphereGeometry(0.04, 8, 6), kit.fur(["#E85D75", "#F2C230", "#F2EEE6"][i]!));
        bloom.position.set(0.24 + 0.17 * Math.cos(-0.3 + i * 0.3), 0.04, 0.1 + i * 0.07 - 0.17 * Math.sin(-0.3 + i * 0.3));
      }
      break;
    }
    case "plant": {
      const pot = new Group();
      pot.position.set(0, 0.11, 0);
      pot.rotation.z = 1.35;
      g.add(pot);
      kit.add(pot, new CylinderGeometry(0.13, 0.09, 0.2, 14), kit.fur("#B5633C"));
      const soil = new SphereGeometry(0.16, 12, 8);
      soil.scale(1.2, 0.25, 1);
      kit.add(g, soil, kit.fur("#3B2A1E"), { outline: false }).position.set(-0.24, 0.02, 0.02);
      for (let i = 0; i < 5; i++) {
        const leaf = new SphereGeometry(0.1, 8, 6);
        leaf.scale(1.5, 0.12, 0.6);
        const l = kit.add(g, leaf, kit.fur(i % 2 ? "#4C8C4A" : "#6DAA5B"));
        l.position.set(-0.3 - i * 0.04, 0.05 + i * 0.012, -0.12 + i * 0.07);
        l.rotation.set(0.2, i * 0.5 - 1, 0.25);
      }
      break;
    }
    case "wineGlass": {
      const glass = new Group();
      glass.position.y = 0.075;
      glass.rotation.z = Math.PI / 2;
      g.add(glass);
      const geo = lathe([[0.07, -0.16], [0.012, -0.15], [0.012, 0], [0.075, 0.06], [0.08, 0.16], [0.07, 0.17]], 14);
      const mat = kit.flat("#CFE8F0", { doubleSide: true, opacity: 0.55 });
      kit.add(glass, geo, mat, { outline: true });
      puddle(kit, g, "#7A1F2B", 0.24, 0.3, 0.04);
      break;
    }
    case "laptop": {
      kit.add(g, new BoxGeometry(0.46, 0.025, 0.32), kit.fur("#8E949C")).position.set(0, 0.015, 0);
      const lid = new Group();
      lid.position.set(0, 0.03, -0.16);
      lid.rotation.x = 1.9;
      lid.rotation.z = 0.12;
      g.add(lid);
      kit.add(lid, new BoxGeometry(0.46, 0.02, 0.32), kit.fur("#8E949C")).position.z = -0.16;
      kit.add(lid, new BoxGeometry(0.4, 0.004, 0.26), kit.flat("#1B2A3A"), { outline: false }).position.set(0, 0.012, -0.16);
      for (let i = 0; i < 5; i++) {
        const crack = kit.add(lid, new BoxGeometry(0.004, 0.002, 0.1 + (i % 3) * 0.04), kit.flat("#CFE8F0"), { outline: false });
        crack.position.set(0.04, 0.016, -0.17);
        crack.rotation.y = i * 1.25;
      }
      shards(kit, g, "#2A2F36", 3, 0.3);
      break;
    }
    case "tv": {
      const tv = new Group();
      tv.position.set(0, 0.2, 0);
      tv.rotation.set(-1.25, 0.3, 0.1);
      g.add(tv);
      kit.add(tv, new BoxGeometry(0.75, 0.44, 0.05), kit.fur("#22242A"));
      kit.add(tv, new BoxGeometry(0.69, 0.38, 0.004), kit.flat("#0B1420"), { outline: false }).position.z = 0.027;
      for (let i = 0; i < 7; i++) {
        const crack = kit.add(tv, new BoxGeometry(0.005, 0.14 + (i % 3) * 0.06, 0.002), kit.flat("#BFE3F2"), { outline: false });
        crack.position.set(-0.12, 0.04, 0.031);
        crack.rotation.z = i * 0.9;
        crack.geometry.translate(0, 0.08, 0);
      }
      shards(kit, g, "#22242A", 4, 0.42);
      break;
    }
    case "mingVase": {
      const white = kit.fur("#F4F1EA");
      const blue = kit.fur("#2447A8");
      twoSided(kit.add(g, lathe([[0, 0], [0.1, 0], [0.16, 0.1], [0.15, 0.2], [0.12, 0.23], [0.15, 0.27], [0.09, 0.24]]), white));
      const band = new TorusGeometry(0.158, 0.014, 5, 20);
      band.rotateX(Math.PI / 2);
      kit.add(g, band, blue, { outline: false }).position.y = 0.11;
      const neck = new Group();
      neck.position.set(0.36, 0.07, 0.12);
      neck.rotation.set(0.2, 0.6, 1.5);
      g.add(neck);
      twoSided(kit.add(neck, lathe([[0.12, 0], [0.06, 0.1], [0.055, 0.2], [0.09, 0.24]]), white));
      const ring = new TorusGeometry(0.06, 0.012, 5, 16);
      ring.rotateX(Math.PI / 2);
      kit.add(neck, ring, blue, { outline: false }).position.y = 0.14;
      shards(kit, g, "#F4F1EA", 5, 0.34);
      shards(kit, g, "#2447A8", 4, 0.26);
      // Museum plinth tag: the only hint of what it used to be worth.
      kit.add(g, new BoxGeometry(0.16, 0.004, 0.08), kit.flat("#E9DFC8"), { outline: false }).position.set(-0.2, 0.004, 0.26);
      break;
    }
    default:
      console.warn(`[scene] unknown broken thing "${key}"`);
  }
  return g;
}

export interface DioramaObject extends CatObject {
  cat: CatObject;
}

/**
 * A revealed cat in its room: floor disc, curved back wall, the cat and the thing it broke.
 * Phase 1 rooms are colour-only; room props arrive with the reveal sequence.
 */
export function createDiorama(spec: CatSpec): DioramaObject {
  const group = new Group();
  group.name = `diorama:${spec.seed}`;
  const kit = new Kit("toon", "#1A1410");

  const floorMat = new MeshLambertMaterial({ color: spec.room.floor });
  const wallMat = new MeshLambertMaterial({ color: spec.room.wall, side: DoubleSide });
  kit.materials.push(floorMat, wallMat);

  const floor = new Mesh(new CylinderGeometry(1.35, 1.35, 0.08, 40), floorMat);
  floor.position.y = -0.04;
  floor.receiveShadow = true;
  const wall = new Mesh(new CylinderGeometry(1.33, 1.33, 1.5, 40, 1, true, Math.PI * 0.62, Math.PI * 0.76), wallMat);
  wall.position.y = 0.75;
  wall.receiveShadow = true;
  kit.geometries.push(floor.geometry, wall.geometry);
  group.add(floor, wall);

  const skirting = new TorusGeometry(1.32, 0.03, 6, 40, Math.PI * 0.76);
  skirting.rotateX(Math.PI / 2);
  skirting.rotateY(Math.PI * 0.88);
  kit.add(group, skirting, kit.fur(spec.room.accent), { outline: false, shadow: false }).position.y = 0.03;

  const cat = createCat(spec);
  group.add(cat.group);

  const broken = buildBrokenThing(kit, spec.brokenThing.key);
  broken.position.set(-0.72, 0, 0.28);
  broken.rotation.y = 0.5;
  group.add(broken);

  return {
    group,
    cat,
    update: (time) => cat.update(time),
    dispose() {
      cat.dispose();
      kit.dispose();
    },
  };
}
