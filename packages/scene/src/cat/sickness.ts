import { BoxGeometry, CylinderGeometry, Group, SphereGeometry, TorusGeometry, Vector3 } from "three";
import type { CatSpec } from "@dno/generator";
import type { Kit } from "../materials";

/**
 * The trophy of a cat that ate past its own limit: one prop per disease, on the floor beside
 * it, in the diorama's low-poly style. `girth` pushes the prop out as far as the belly goes,
 * so a huge cat does not swallow it. `curled`: the cat lies across the front, head to the
 * right, so the prop goes in front of its belly instead.
 */
export function addSickness(kit: Kit, weight: CatSpec["weight"], parent: Group, girth: Vector3, curled: boolean): void {
  if (!weight?.sick || !weight.disease) return;
  const prop = new Group();
  prop.name = `sick:${weight.disease}`;
  parent.add(prop);
  const place = (sitting: number[], lyingDown: number[]) => prop.position.fromArray(curled ? lyingDown : sitting);

  switch (weight.disease) {
    case "diabetic": {
      // An insulin pen, lying in front: white barrel, orange cap, a dose window and a dial.
      const pen = new Group();
      kit.add(pen, new CylinderGeometry(0.02, 0.02, 0.2, 10), kit.fur("#F2EEE6"), { thickness: 0.006 });
      kit.add(pen, new CylinderGeometry(0.023, 0.023, 0.07, 10), kit.fur("#E8893A"), { thickness: 0.006 }).position.y = 0.13;
      kit.add(pen, new CylinderGeometry(0.014, 0.014, 0.03, 8), kit.fur("#8E949C"), { thickness: 0.006 }).position.y = -0.115;
      kit.add(pen, new BoxGeometry(0.012, 0.05, 0.006), kit.flat("#4FA3E0"), { outline: false }).position.set(0, 0.02, 0.019);
      pen.rotation.set(Math.PI / 2, 0, Math.PI / 2 - 0.5);
      prop.add(pen);
      place([0.26, 0.022, 0.42], [-0.1, 0.022, 0.62]);
      break;
    }
    case "arthritic": {
      // A walking cane, leaning in towards the cat.
      const cane = new Group();
      kit.add(cane, new CylinderGeometry(0.013, 0.013, 0.42, 8), kit.fur("#8A5A2B"), { thickness: 0.006 }).position.y = 0.21;
      const hook = kit.add(cane, new TorusGeometry(0.045, 0.013, 6, 12, Math.PI), kit.fur("#8A5A2B"), { thickness: 0.006 });
      hook.position.set(-0.045, 0.42, 0);
      kit.add(cane, new SphereGeometry(0.018, 8, 6), kit.fur("#2B2622"), { thickness: 0.006 });
      cane.rotation.z = 0.28;
      prop.add(cane);
      place([0.46, 0, 0.16], [-0.2, 0, 0.5]);
      break;
    }
    case "fattyLiver": {
      // A hot-water bottle for the sore belly: a squashed red pillow with a neck and a stopper.
      const pillow = kit.add(prop, new SphereGeometry(0.1, 12, 8), kit.fur("#D9483B"), { thickness: 0.008 });
      pillow.scale.set(1.15, 0.32, 0.85);
      pillow.position.y = 0.032;
      kit.add(prop, new CylinderGeometry(0.026, 0.032, 0.05, 10), kit.fur("#D9483B"), { thickness: 0.006 }).position.set(0, 0.04, -0.1);
      kit.add(prop, new CylinderGeometry(0.03, 0.03, 0.02, 10), kit.fur("#F2EEE6"), { thickness: 0.006 }).position.set(0, 0.04, -0.13);
      prop.children.slice(1).forEach((c) => (c.rotation.x = Math.PI / 2));
      prop.rotation.y = -0.6;
      place([0.22, 0, 0.42], [-0.12, 0, 0.62]);
      break;
    }
  }
  prop.position.multiply(girth);
}
