import { BufferAttribute, BufferGeometry, Group, Mesh, Object3D, Vector3 } from "three";
import type { RatSpec } from "@dno/generator";
import type { AssetLibrary } from "../assets/gltf";
import { BentTail } from "../bentTail";
import { addPart, anchored, catAssetLibrary, find, isPlaceholder, prepareKit } from "../cat/kitParts";
import { Kit, type ZonePalette } from "../materials";

export interface RatObject {
  group: Group;
  /** Advance animations. `time` in seconds. */
  update(time: number): void;
  dispose(): void;
  /**
   * Resolves once the kit has loaded and the rat is in `group`. The group is usable
   * straight away; it is simply empty until then. Offscreen renders must await this.
   */
  ready: Promise<void>;
}

export interface RatOptions {
  /** Where to load the kit from. Defaults to the shared library. */
  assets?: AssetLibrary;
}

/** The tail is modelled straight, as this many segments of this length. Matches rats.py. */
const TAIL_SEGMENTS = 10;
const TAIL_SEGMENT = 0.1;
/** Where the snout starts on the head model, along +Z. Matches SNOUT_FROM in rats.py. */
const SNOUT_FROM = 0.1;

/** How the tail lies in each pose: a sideways curl along the floor, the tip turning up. */
const TAIL_CURL: Record<RatSpec["pose"], { curl: number; lift: number; drop: number }> = {
  sit: { curl: 0.16, lift: 0.4, drop: 0 },
  stand: { curl: 0.14, lift: 0.4, drop: 0 },
  sniff: { curl: 0.12, lift: 0.35, drop: 0.12 },
};

const HAT_COLORS: Partial<Record<RatSpec["hat"], string>> = { party: "#E8467C", beanie: "#2E6FD8" };

/** A copy of the head with everything in front of SNOUT_FROM stretched by `k`. */
function stretchSnout(src: BufferGeometry, k: number): BufferGeometry {
  const geometry = src.clone();
  const pos = geometry.getAttribute("position") as BufferAttribute;
  const normal = geometry.getAttribute("normal") as BufferAttribute;
  const n = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z <= SNOUT_FROM) continue;
    pos.setZ(i, SNOUT_FROM + (z - SNOUT_FROM) * k);
    n.set(normal.getX(i), normal.getY(i), normal.getZ(i) / k).normalize();
    normal.setXYZ(i, n.x, n.y, n.z);
  }
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * Turns a RatSpec into an animated three.js rat, drawn from the Blender rat kit with the
 * game's toon materials and outline. Origin at the floor, facing +z, about as tall as a cat.
 * The kit loads in the background: the group is returned at once and fills in when `ready`
 * resolves.
 */
export function createRat(spec: RatSpec, opts: RatOptions = {}): RatObject {
  const group = new Group();
  group.name = `rat:${spec.seed}`;
  const kit = new Kit("toon", spec.colors.outline);
  const assets = opts.assets ?? catAssetLibrary();
  let disposed = false;
  let animate: ((time: number) => void) | null = null;

  const ready = assets.shared("rat").then((root) => {
    if (disposed) return;
    if (isPlaceholder(root)) {
      group.add(root.clone());
      return;
    }
    animate = buildRat(spec, kit, prepareKit(root), group);
  });

  return {
    group,
    ready,
    update(time) {
      animate?.(time);
    },
    dispose() {
      disposed = true;
      kit.dispose();
    },
  };
}

function buildRat(spec: RatSpec, kit: Kit, models: Object3D, group: Group): (time: number) => void {
  const c = spec.colors;
  const b = spec.body;
  const hooded = spec.coat === "hooded";
  const dark = spec.coat === "black";
  const geometryOf = (name: string) => (find(models, name) as Mesh).geometry;

  // A patched rat's patches (one round an eye) and a hooded rat's hood are zones of the
  // fur; the head of a hooded rat is all hood.
  const bodyPalette: ZonePalette = {
    base: c.fur,
    secondary: spec.coat === "patched" ? c.patch : c.fur,
    tertiary: hooded ? c.patch : c.fur,
    belly: c.belly,
    skin: c.skin,
  };
  const headFur = hooded ? c.patch : c.fur;
  const headPalette: ZonePalette = { base: headFur, secondary: spec.coat === "patched" ? c.patch : headFur, tertiary: headFur, belly: hooded ? c.patch : c.belly, skin: c.skin };
  const fur = kit.zoned(bodyPalette);
  const headZoned = kit.zoned(headPalette);
  // Mouths and freckles are drawn lines: dark on light fur, pale on a black rat.
  const line = dark ? "#E9E2EC" : "#1A1410";
  const thin = { thickness: 0.006 };

  const waving = spec.pose === "stand" && spec.prop === "none";
  const pose = waving ? "wave" : spec.pose;
  const rig = new Group();
  group.add(rig);

  // --- Body: widened by girth, stretched by height, breathing about its own centre ---
  const scale = new Vector3(b.girth, b.height, b.girth);
  const bodyGeo = geometryOf(`body_${pose}`);
  const centre = bodyGeo.boundingBox!.getCenter(new Vector3()).multiply(scale);
  const bodyGroup = new Group();
  bodyGroup.position.copy(centre);
  rig.add(bodyGroup);
  const bodyMesh = kit.add(bodyGroup, bodyGeo, fur, { shared: true });
  bodyMesh.position.copy(centre).negate();
  bodyMesh.scale.copy(scale);
  /** A group at a body anchor, moved with the body's girth and height. */
  const onBody = (name: string) => {
    const g = anchored(rig, find(models, `body_${pose}__${name}`));
    g.position.multiply(scale);
    return g;
  };

  // --- Tail ---
  const tail = new BentTail(geometryOf("tail"), 1, TAIL_SEGMENT * b.tail, TAIL_SEGMENTS, TAIL_SEGMENT);
  const tailMesh = kit.add(onBody("tail"), tail.geometry, fur);
  // Its bounds change every frame; a rat is always on screen as a whole anyway.
  tailMesh.frustumCulled = false;
  tailMesh.children.forEach((outline) => (outline.frustumCulled = false));

  // --- Head: the snout stretched to this rat's length, every anchor on it moved along ---
  const neck = onBody("head");
  neck.scale.setScalar(b.head);
  const head = new Group();
  neck.add(head);
  const snout = (p: Vector3) => {
    if (p.z > SNOUT_FROM) p.z = SNOUT_FROM + (p.z - SNOUT_FROM) * b.snout;
    return p;
  };
  kit.add(head, stretchSnout(geometryOf("head"), b.snout), headZoned);
  const onHead = (name: string) => {
    const g = anchored(head, find(models, `head__${name}`));
    snout(g.position);
    return g;
  };

  // Ears: round dishes, one of them perhaps bitten and patched up.
  const ears: Group[] = [];
  ([-1, 1] as const).forEach((side) => {
    const s = side < 0 ? "L" : "R";
    const ear = new Group();
    ear.scale.setScalar(b.ears);
    onHead(`ear_${s}`).add(ear);
    ears.push(ear);
    const nicked = spec.nickedEar && side > 0;
    kit.add(ear, geometryOf(nicked ? "ear_R_nicked" : `ear_${s}`), headZoned, { shared: true });
    if (nicked) addPart(kit, ear, find(models, "plaster"), thin);
  });

  // Eyes: beads, cartoon eyes with a will of their own, or shades.
  if (spec.eyes === "shades") {
    addPart(kit, onHead("face"), find(models, "shades"), thin);
  } else {
    ([-1, 1] as const).forEach((side) => {
      const eye = onHead(`eye_${side < 0 ? "L" : "R"}`);
      if (spec.eyes === "dots") {
        eye.scale.setScalar(1.1);
        addPart(kit, eye, find(models, "eye_bead"), { colors: { iris: c.eye } });
        addPart(kit, eye, find(models, "eye_bead_glint"));
        return;
      }
      if (spec.eyes === "big") eye.scale.setScalar(1.2);
      addPart(kit, eye, find(models, "eye_ball"), thin);
      const look = new Group();
      eye.add(look);
      // A derp: each eye has its own opinion.
      // Pupils a little towards the nose, so the rat looks at you; a derp's each have their own opinion.
      look.position.set(-side * 0.006, 0.006, 0);
      if (spec.eyes === "derp") look.position.set(side < 0 ? 0.016 : 0.004, side < 0 ? -0.016 : 0.018, 0);
      if (spec.eyes === "sleepy") look.position.y = -0.016;
      addPart(kit, look, find(models, "eye_pupil"), { colors: { iris: c.eye } });
      addPart(kit, look, find(models, "eye_glint"));
      if (spec.eyes === "sleepy") {
        // The lid covers the top half of the eye; tipped forward it comes down further.
        const around = side > 0 && spec.coat === "patched" ? c.patch : headFur;
        const lid = addPart(kit, eye, find(models, "eye_lid"), { colors: { fur: around }, ...thin });
        lid.rotation.x = 0.45;
      }
    });
  }

  const whiskers: Group[] = [];
  ([-1, 1] as const).forEach((side) => {
    const s = side < 0 ? "L" : "R";
    const w = onHead(`whisker_${s}`);
    whiskers.push(w);
    addPart(kit, w, find(models, `whiskers_${s}`), { colors: { whisker: dark ? "#C9C2CC" : "#3A3036", dark: line } });
    if (spec.face === "grin" || spec.face === "tongue") addPart(kit, onHead(`cheek_${s}`), find(models, "blush"));
  });

  // The mouth: buck teeth, the rat's whole personality, and whatever it is doing with them.
  const mouth = onHead("mouth");
  if (spec.face !== "shock") {
    const teeth = new Group();
    const size = (spec.face === "teeth" ? 1.45 : 1) * b.teeth;
    teeth.scale.set(1 + (size - 1) * 0.4, size, 1);
    mouth.add(teeth);
    addPart(kit, teeth, find(models, "teeth"), thin);
    addPart(kit, teeth, find(models, "tooth_gap"));
  }
  if (spec.face === "grin" || spec.face === "smug") addPart(kit, mouth, find(models, `mouth_${spec.face}`), { colors: { dark: line } });
  else if (spec.face === "shock") addPart(kit, mouth, find(models, "mouth_shock"), { colors: { dark: line === "#1A1410" ? "#3A1418" : "#1A1410" } });
  else if (spec.face === "tongue") addPart(kit, mouth, find(models, "tongue"), thin);

  if (spec.hat !== "none") {
    const color = HAT_COLORS[spec.hat];
    addPart(kit, onHead("hat"), find(models, `hat_${spec.hat}`), { colors: color ? { main: color } : {}, thickness: 0.008 });
  }
  if (spec.scarf) addPart(kit, onBody("neck"), find(models, "bandana"), { colors: { main: spec.scarf }, thickness: 0.008 });
  if (spec.prop !== "none") addPart(kit, onBody("hands"), find(models, `prop_${spec.prop}`), { thickness: 0.008 });

  let arm: Group | null = null;
  if (waving) {
    arm = onBody("arm");
    kit.add(arm, geometryOf("arm_wave"), fur, { shared: true });
  }

  const anim = spec.animation;
  const sniffing = spec.pose === "sniff" ? 1.6 : 1;
  const { curl, lift, drop } = TAIL_CURL[spec.pose];
  const last = TAIL_SEGMENTS - 1;

  return (time) => {
    const breathe = Math.sin(time * 2.2) * 0.018;
    bodyGroup.scale.set(1 + breathe, 1 + breathe * 0.5, 1 + breathe);
    // Sniff in short bursts: the head bobs, the whiskers go.
    const burst = Math.max(0, Math.sin(time * 0.9)) ** 2 * sniffing;
    const twitch = Math.sin(time * anim.sniffSpeed) * burst;
    head.rotation.x = twitch * 0.035;
    head.rotation.y = Math.sin(time * 0.5) * 0.12;
    head.rotation.z = Math.sin(time * 0.37) * 0.05;
    whiskers.forEach((w, i) => (w.rotation.y = (i ? -1 : 1) * twitch * 0.15));
    ears.forEach((ear, i) => (ear.rotation.z = (i ? -1 : 1) * Math.sin(time * anim.earSpeed + i) * 0.08));
    tail.bend((i) => {
      const k = i / last;
      const sway = Math.sin(time * anim.tailSpeed - i * 0.5) * anim.tailAmplitude * 0.35 * (0.3 + k);
      // Down to the floor first if it starts above it, then along it, the tip curling up.
      const rx = i === 1 ? -drop : i === 2 ? drop * 0.8 : i === last ? lift : 0;
      // Curled towards the rat's left (+x), the side a stage turned to -0.35 shows.
      return [rx, i === 0 ? sway * 0.5 : -curl + sway];
    });
    rig.position.y = Math.abs(Math.sin(time * 5)) * anim.bounce;
    if (arm) arm.rotation.z = Math.sin(time * 6) * 0.35;
  };
}
