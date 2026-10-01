import { Box3, BoxGeometry, CylinderGeometry, Group, SphereGeometry, TorusGeometry, Vector3 } from "three";
import type { CatSpec, Pose } from "@dno/generator";
import type { Kit } from "../materials";

export interface SickFrame {
  pose: Pose;
  /** The reshaped body, in the cat's space: props go against it, not inside it. */
  bounds: Box3;
  /** Moves a point of the rest body to where the reshaped body has it. */
  place(p: Vector3): Vector3;
}

/** Front paws in the rest body, from the Blender kit (cats.py, times its BODY_SCALE of 0.8). */
const PAW: Record<Pose, [number, number, number]> = {
  sit: [0.076, 0.04, 0.2],
  float: [0.088, 0.056, 0.264],
  crouch: [0.168, 0.04, 0.56],
  loaf: [0.104, 0.04, 0.344],
  curl: [0.384, 0.048, 0.176],
};

/**
 * The trophy of a cat that ate past its own limit, in the diorama's low-poly style:
 *
 * - diabetic: a blue insulin pen at its paws, and the big water bowl it never leaves;
 * - arthritic: a walking cane against its side, and a bandaged paw;
 * - fatty liver: a hot-water bottle against its belly (the yellowed skin and eyes are
 *   drawn with the cat).
 */
export function addSickness(kit: Kit, weight: CatSpec["weight"], parent: Group, frame: SickFrame): void {
  if (!weight?.sick || !weight.disease) return;
  const prop = new Group();
  prop.name = `sick:${weight.disease}`;
  parent.add(prop);
  const { min, max } = frame.bounds;
  // A curled cat lies across the front: its side is its front.
  const front = frame.pose === "curl" ? max.z + 0.06 : max.z + 0.04;
  const side = max.x + 0.06;
  const ink = { thickness: 0.007 };

  switch (weight.disease) {
    case "diabetic": {
      // Pen, so it is never taken for a cigarette: a blue body, a grey cap with a clip, a dose
      // dial at the end and a yellow label.
      const pen = new Group();
      kit.add(pen, new CylinderGeometry(0.034, 0.034, 0.3, 12), kit.fur("#2F6FB0"), ink);
      kit.add(pen, new CylinderGeometry(0.037, 0.037, 0.11, 12), kit.fur("#C9CED6"), ink).position.y = 0.2;
      kit.add(pen, new BoxGeometry(0.012, 0.08, 0.016), kit.fur("#C9CED6"), { thickness: 0.005 }).position.set(0, 0.2, 0.042);
      kit.add(pen, new CylinderGeometry(0.028, 0.034, 0.05, 12), kit.fur("#1E3F66"), ink).position.y = -0.17;
      kit.add(pen, new CylinderGeometry(0.0354, 0.0354, 0.08, 12, 1, true, -0.6, 1.2), kit.flat("#F2C230", { doubleSide: true }), {
        outline: false,
      }).position.y = 0.02;
      pen.rotation.set(Math.PI / 2, 0, Math.PI / 2 - 0.45);
      pen.position.set(-0.12, 0.034, front + 0.1);
      prop.add(pen);

      // Bowl: always drinking.
      const bowl = new Group();
      kit.add(bowl, new CylinderGeometry(0.17, 0.13, 0.08, 24), kit.fur("#3F7FC0"), ink).position.y = 0.04;
      kit.add(bowl, new CylinderGeometry(0.15, 0.15, 0.01, 24), kit.flat("#A9DBF5"), { outline: false }).position.y = 0.078;
      bowl.position.set(Math.min(side, 0.42), 0, front + 0.06);
      prop.add(bowl);
      break;
    }
    case "arthritic": {
      // A cane, leaning on the cat's flank.
      const cane = new Group();
      const wood = kit.fur("#8A5A2B");
      kit.add(cane, new CylinderGeometry(0.018, 0.018, 0.6, 8), wood, ink).position.y = 0.3;
      const hook = kit.add(cane, new TorusGeometry(0.06, 0.018, 8, 14, Math.PI), wood, ink);
      hook.position.set(-0.06, 0.6, 0);
      kit.add(cane, new SphereGeometry(0.024, 8, 6), kit.fur("#2B2622"), ink);
      cane.rotation.z = 0.32;
      cane.position.set(side + 0.1, 0, (min.z + max.z) / 2 + 0.12);
      prop.add(cane);

      // A bandaged front paw, with a safety pin.
      const paw = frame.place(new Vector3(...PAW[frame.pose]));
      const wrap = new Group();
      kit.add(wrap, new CylinderGeometry(0.085, 0.09, 0.09, 16), kit.fur("#F4F0E6"), ink);
      for (const y of [-0.022, 0.022]) {
        const turn = kit.add(wrap, new TorusGeometry(0.088, 0.009, 6, 18), kit.fur("#DCD2BE"), { outline: false });
        turn.rotation.x = Math.PI / 2;
        turn.position.y = y;
      }
      kit.add(wrap, new CylinderGeometry(0.007, 0.007, 0.07, 6), kit.fur("#B8BEC6"), { outline: false }).position.set(0.06, 0, 0.065);
      // The paw sinks into a fat belly: the bandage stays out where it can be seen.
      wrap.position.set(paw.x, paw.y + 0.03, Math.max(paw.z, front - 0.08));
      prop.add(wrap);
      break;
    }
    case "fattyLiver": {
      // A hot-water bottle against the sore belly: a squashed red pillow, a neck and a stopper.
      const bottle = new Group();
      const rubber = kit.fur("#D9483B");
      const pillow = kit.add(bottle, new SphereGeometry(0.16, 16, 10), rubber, { thickness: 0.009 });
      pillow.scale.set(1.15, 0.36, 0.85);
      pillow.position.y = 0.055;
      // Ribs moulded in the rubber.
      for (let i = -1; i <= 1; i++) {
        const rib = kit.add(bottle, new TorusGeometry(0.1 - Math.abs(i) * 0.03, 0.006, 4, 16), kit.fur("#B83A2F"), { outline: false });
        rib.rotation.x = Math.PI / 2;
        rib.scale.set(1.15, 0.85, 1);
        rib.position.y = 0.11 + i * 0.002;
      }
      const neck = kit.add(bottle, new CylinderGeometry(0.04, 0.05, 0.07, 12), rubber, ink);
      neck.rotation.x = Math.PI / 2;
      neck.position.set(0, 0.06, -0.16);
      const stopper = kit.add(bottle, new CylinderGeometry(0.046, 0.046, 0.03, 12), kit.fur("#F2EEE6"), ink);
      stopper.rotation.x = Math.PI / 2;
      stopper.position.set(0, 0.06, -0.205);
      bottle.rotation.y = Math.PI - 0.5;
      bottle.position.set(0.12, 0, front + 0.1);
      prop.add(bottle);
      break;
    }
  }
}
