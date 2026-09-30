import { BoxGeometry, ConeGeometry, CylinderGeometry, Group, OctahedronGeometry, SphereGeometry, TorusGeometry } from "three";
import { GOLD, type CatSpec } from "@dno/generator";
import { toon } from "../materials";
import type { Kit } from "../materials";

interface Anchors {
  /** Head group, origin at the centre of the skull. */
  head: Group;
  /** Neck group, origin where a collar sits. */
  neck: Group;
  /** Skull radius. Every accessory is sized from it. */
  R: number;
}

/** Attaches the accessory named in the spec. A golden accessory swaps every colour for gold. */
export function addAccessory(kit: Kit, accessory: CatSpec["accessory"], { head, neck, R }: Anchors): void {
  const { key, golden } = accessory;
  if (key === "none") return;

  const goldMat = () => {
    if (kit.mode === "ghost") return kit.fur(GOLD);
    const m = toon(GOLD, { emissive: "#7A5A00", emissiveIntensity: 0.6 });
    kit.materials.push(m);
    return m;
  };
  const gold = golden ? goldMat() : null;
  const main = gold ?? kit.fur(accessory.color);
  const alt = (color: string) => gold ?? kit.fur(color);
  const collarR = R * 0.66;

  switch (key) {
    case "bellCollar": {
      const band = new TorusGeometry(collarR, R * 0.085, 8, 24);
      band.rotateX(Math.PI / 2);
      kit.add(neck, band, main);
      kit.add(neck, new SphereGeometry(R * 0.16, 12, 10), alt("#E8B931")).position.set(0, -R * 0.12, collarR + R * 0.1);
      break;
    }
    case "bowTie": {
      const band = new TorusGeometry(collarR, R * 0.05, 6, 24);
      band.rotateX(Math.PI / 2);
      kit.add(neck, band, main, { outline: false });
      for (const side of [-1, 1]) {
        const wing = new ConeGeometry(R * 0.26, R * 0.42, 4);
        wing.scale(1, 1, 0.45);
        wing.rotateZ((side * Math.PI) / 2);
        kit.add(neck, wing, main).position.set(side * R * 0.2, -R * 0.02, collarR + R * 0.12);
      }
      kit.add(neck, new SphereGeometry(R * 0.1, 10, 8), main).position.set(0, -R * 0.02, collarR + R * 0.14);
      break;
    }
    case "bandana": {
      const band = new TorusGeometry(collarR, R * 0.07, 6, 24);
      band.rotateX(Math.PI / 2);
      kit.add(neck, band, main);
      const flap = new ConeGeometry(R * 0.42, R * 0.55, 3);
      flap.scale(1, 1, 0.2);
      flap.rotateZ(Math.PI);
      const f = kit.add(neck, flap, main);
      f.position.set(0, -R * 0.3, collarR + R * 0.04);
      f.rotation.x = -0.25;
      break;
    }
    case "sunglasses": {
      const lensMat = gold ?? kit.flat(accessory.color);
      for (const side of [-1, 1]) {
        const lens = new CylinderGeometry(R * 0.31, R * 0.31, R * 0.06, 20);
        lens.rotateX(Math.PI / 2);
        const l = kit.add(head, lens, lensMat, { outline: false });
        l.position.set(side * R * 0.42, R * 0.1, R * 0.93);
        l.rotation.y = side * 0.38;
        const arm = kit.add(head, new BoxGeometry(R * 0.05, R * 0.05, R * 0.95), lensMat, { outline: false });
        arm.position.set(side * R * 0.98, R * 0.12, R * 0.4);
        arm.rotation.y = side * 0.22;
      }
      kit.add(head, new BoxGeometry(R * 0.4, R * 0.06, R * 0.05), lensMat, { outline: false }).position.set(0, R * 0.16, R * 1.0);
      break;
    }
    case "partyHat": {
      const hat = new Group();
      hat.position.set(R * 0.2, R * 0.78, 0);
      hat.rotation.z = -0.25;
      head.add(hat);
      const cone = new ConeGeometry(R * 0.38, R * 1.0, 16);
      cone.translate(0, R * 0.5, 0);
      kit.add(hat, cone, main);
      for (const y of [0.22, 0.52]) {
        const ring = new TorusGeometry(R * 0.38 * (1 - y) + R * 0.01, R * 0.03, 5, 16);
        ring.rotateX(Math.PI / 2);
        kit.add(hat, ring, alt("#F2E85C"), { outline: false }).position.y = R * y;
      }
      kit.add(hat, new SphereGeometry(R * 0.11, 10, 8), alt("#F2E85C")).position.y = R * 1.02;
      break;
    }
    case "monocle": {
      const rim = kit.add(head, new TorusGeometry(R * 0.3, R * 0.035, 6, 20), main, { outline: false });
      rim.position.set(R * 0.42, R * 0.1, R * 0.92);
      rim.rotation.y = 0.42;
      const chain = new CylinderGeometry(R * 0.012, R * 0.012, R * 0.9, 4);
      chain.translate(0, -R * 0.45, 0);
      const c = kit.add(head, chain, main, { outline: false });
      c.position.set(R * 0.66, -R * 0.08, R * 0.82);
      c.rotation.z = 0.15;
      break;
    }
    case "wizardHat": {
      const hat = new Group();
      hat.position.set(0, R * 0.72, -R * 0.05);
      hat.rotation.x = -0.12;
      head.add(hat);
      kit.add(hat, new CylinderGeometry(R * 0.95, R * 0.95, R * 0.06, 24), main);
      const lower = new ConeGeometry(R * 0.55, R * 0.9, 16, 1, true);
      lower.translate(0, R * 0.45, 0);
      kit.add(hat, lower, main);
      const tip = new Group();
      tip.position.y = R * 0.62;
      tip.rotation.z = 0.5;
      hat.add(tip);
      const upper = new ConeGeometry(R * 0.2, R * 0.7, 12);
      upper.translate(0, R * 0.35, 0);
      kit.add(tip, upper, main);
      for (const [x, y, z] of [[0.3, 0.3, 0.42], [-0.22, 0.55, 0.3], [0.05, 0.15, 0.52]] as const) {
        kit.add(hat, new OctahedronGeometry(R * 0.07), alt("#F2E85C"), { outline: false }).position.set(R * x, R * y, R * z);
      }
      break;
    }
    case "crown": {
      const crown = new Group();
      crown.position.set(0, R * 0.78, 0);
      head.add(crown);
      kit.add(crown, new CylinderGeometry(R * 0.5, R * 0.46, R * 0.28, 16, 1, true), main);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const spike = new ConeGeometry(R * 0.11, R * 0.3, 4);
        kit.add(crown, spike, main).position.set(Math.cos(a) * R * 0.48, R * 0.28, Math.sin(a) * R * 0.48);
        const gem = kit.add(crown, new SphereGeometry(R * 0.06, 8, 6), alt(i % 2 ? "#C2261D" : "#2B6CB0"), { outline: false });
        gem.position.set(Math.cos(a + 0.52) * R * 0.5, 0, Math.sin(a + 0.52) * R * 0.5);
      }
      break;
    }
    case "halo": {
      const ring = new TorusGeometry(R * 0.55, R * 0.06, 8, 28);
      ring.rotateX(Math.PI / 2);
      const halo = kit.add(head, ring, kit.flat(golden ? GOLD : accessory.color), { outline: false, shadow: false });
      halo.position.set(0, R * 1.45, 0);
      halo.rotation.z = 0.12;
      break;
    }
    default:
      console.warn(`[scene] unknown accessory "${key}"`);
  }
}
