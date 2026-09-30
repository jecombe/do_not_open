import type { Object3D } from "three";
import { GOLD, type CatSpec } from "@dno/generator";
import { toon } from "../materials";
import type { Kit } from "../materials";
import { addPart } from "./kitParts";

/** Where accessories hang. Each is a group already placed on the cat, scaled for its breed. */
export interface Anchors {
  neck: Object3D;
  face: Object3D;
  eye_R: Object3D;
  hat: Object3D;
}

/**
 * Attaches the accessory named in the spec. The model says which anchor it wants, so
 * any accessory fits any breed in any pose. A golden accessory swaps every colour for gold.
 */
export function addAccessory(kit: Kit, accessory: CatSpec["accessory"], parts: Object3D, anchors: Anchors): void {
  const { key, golden } = accessory;
  if (key === "none") return;
  const part = parts.getObjectByName(`accessory_${key}`);
  const anchor = part && anchors[part.userData.anchor as keyof Anchors];
  if (!part || !anchor) {
    console.warn(`[scene] unknown accessory "${key}"`);
    return;
  }

  let gold;
  if (golden && kit.mode === "toon") {
    gold = toon(GOLD, { emissive: "#7A5A00", emissiveIntensity: 0.6 });
    kit.materials.push(gold);
  } else if (golden) {
    gold = kit.fur(GOLD);
  }
  addPart(kit, anchor, part, { colors: { main: accessory.color }, override: gold, thickness: 0.009 });
}
