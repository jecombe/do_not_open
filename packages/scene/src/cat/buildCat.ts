import { BufferAttribute, BufferGeometry, Euler, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, Vector3 } from "three";
import type { CatBody, CatSpec, Pose } from "@dno/generator";
import type { AssetLibrary } from "../assets/gltf";
import { Kit, type ZonePalette } from "../materials";
import { addAccessory } from "./accessories";
import { addPart, anchored, breedOf, catAssetLibrary, find, isPlaceholder, prepareKit, type CatBreed } from "./kitParts";

export interface CatObject {
  group: Group;
  /** Advance animations. `time` in seconds. */
  update(time: number): void;
  dispose(): void;
  /**
   * Resolves once the kit has loaded and the cat is in `group`. The group is usable
   * straight away; it is simply empty until then. Offscreen renders must await this.
   */
  ready: Promise<void>;
}

export interface CatOptions {
  /** Where to load the kit from. Defaults to the shared library. */
  assets?: AssetLibrary;
}

interface PoseLayout {
  /** Girth widens a sitting cat front to back as well; a lying one only sideways. */
  deep: boolean;
  tail: { curlAxis: "x" | "z"; curl: number; segLen: number };
}

/** What the models cannot carry: how each pose moves. Shapes and anchors live in the kit. */
const POSES: Record<Pose, PoseLayout> = {
  sit: { deep: true, tail: { curlAxis: "x", curl: 0.24, segLen: 0.125 } },
  loaf: { deep: false, tail: { curlAxis: "z", curl: -0.4, segLen: 0.12 } },
  crouch: { deep: false, tail: { curlAxis: "x", curl: 0.1, segLen: 0.1 } },
  curl: { deep: false, tail: { curlAxis: "z", curl: 0.42, segLen: 0.13 } },
  float: { deep: true, tail: { curlAxis: "x", curl: 0.3, segLen: 0.1 } },
};

/** The tail is modelled straight, as this many segments of this length. Matches cats.py. */
const TAIL_SEGMENTS = 7;
const TAIL_SEGMENT = 0.107;

/**
 * Bends the straight tail model along a chain of joints, on the CPU. A few hundred
 * vertices per cat, and the outline and the ghost shader follow for free because they
 * share the geometry.
 */
class BentTail {
  readonly geometry: BufferGeometry;
  private readonly rest: Float32Array;
  private readonly restNormal: Float32Array;
  private readonly position: BufferAttribute;
  private readonly normal: BufferAttribute;
  private readonly joints: Matrix4[] = [];
  private readonly step = new Matrix4();
  private readonly turn = new Matrix4();
  private readonly euler = new Euler();
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  constructor(src: BufferGeometry, fluff: number, private readonly segLen: number) {
    const stretch = segLen / TAIL_SEGMENT;
    const srcPos = src.getAttribute("position");
    const srcNormal = src.getAttribute("normal");
    const n = srcPos.count;
    this.rest = new Float32Array(n * 3);
    this.restNormal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.rest.set([srcPos.getX(i) * fluff, srcPos.getY(i) * stretch, srcPos.getZ(i) * fluff], i * 3);
      this.a.set(srcNormal.getX(i) / fluff, srcNormal.getY(i) / stretch, srcNormal.getZ(i) / fluff).normalize();
      this.restNormal.set([this.a.x, this.a.y, this.a.z], i * 3);
    }
    this.geometry = new BufferGeometry();
    this.position = new BufferAttribute(new Float32Array(this.rest), 3);
    this.normal = new BufferAttribute(new Float32Array(this.restNormal), 3);
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("normal", this.normal);
    const zone = src.getAttribute("zone");
    if (zone) this.geometry.setAttribute("zone", zone);
    this.geometry.setIndex(src.getIndex());
    for (let i = 0; i < TAIL_SEGMENTS; i++) this.joints.push(new Matrix4());
    this.step.makeTranslation(0, segLen, 0);
  }

  /** `rotation(i)` gives the local x and z rotation of joint i. */
  bend(rotation: (i: number) => [number, number]): void {
    this.joints.forEach((joint, i) => {
      const [rx, rz] = rotation(i);
      this.turn.makeRotationFromEuler(this.euler.set(rx, 0, rz));
      if (i === 0) joint.copy(this.turn);
      else joint.multiplyMatrices(this.joints[i - 1]!, this.step).multiply(this.turn);
    });
    const { rest, restNormal, a, b, segLen } = this;
    const pos = this.position.array as Float32Array;
    const nor = this.normal.array as Float32Array;
    const last = TAIL_SEGMENTS - 1;
    for (let i = 0; i < rest.length; i += 3) {
      const x = rest[i]!;
      const y = rest[i + 1]!;
      const z = rest[i + 2]!;
      const t = Math.max(0, y / segLen);
      const seg = Math.min(last, Math.floor(t));
      const w = seg === last ? 0 : t - seg;
      a.set(x, y - seg * segLen, z).applyMatrix4(this.joints[seg]!);
      if (w > 0) a.lerp(b.set(x, y - (seg + 1) * segLen, z).applyMatrix4(this.joints[seg + 1]!), w);
      pos[i] = a.x;
      pos[i + 1] = a.y;
      pos[i + 2] = a.z;
      a.set(restNormal[i]!, restNormal[i + 1]!, restNormal[i + 2]!).transformDirection(this.joints[seg]!);
      if (w > 0) a.lerp(b.set(restNormal[i]!, restNormal[i + 1]!, restNormal[i + 2]!).transformDirection(this.joints[seg + 1]!), w).normalize();
      nor[i] = a.x;
      nor[i + 1] = a.y;
      nor[i + 2] = a.z;
    }
    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
  }
}

/** Rough perceived brightness of a #RRGGBB colour, 0..1. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

interface Form {
  group: Group;
  update(time: number): void;
}

/** Breeds whose eyes do not quite agree. Offsets of the iris, as [towards the nose, up]. */
const GAZE: Partial<Record<CatBreed, [number, number]>> = {
  siamese: [0.02, 0],
  orange: [-0.013, 0.008],
};

function buildForm(spec: CatSpec, body: CatBody, breed: CatBreed, kit: Kit, parts: Object3D, models: Object3D): Form {
  const layout = POSES[spec.pose];
  const face = spec.face;
  const group = new Group();
  const p = body.pattern;
  const vice = spec.vice;
  const palette: ZonePalette = {
    base: body.furBase,
    secondary: body.furSecondary,
    tertiary: body.furTertiary,
    belly: body.furBelly,
    skin: body.skin,
  };
  const fur = kit.zoned(palette);
  // Brows, closed eyes and mouths are drawn lines: dark on light fur, pale on dark fur.
  const line = (on: string) => (p === "solid" ? "#6A6488" : luminance(on) < 0.2 ? "#EFE6D6" : "#1A1410");
  const aroundEye = (side: number) =>
    p === "calico" ? (side > 0 ? body.furSecondary : body.furTertiary) : p === "loaf" ? body.furBelly : body.furBase;
  const muzzle = p === "tuxedo" || p === "points" ? body.furSecondary : p === "solid" || p === "glitch" ? body.furBase : body.furBelly;
  const geometryOf = (name: string) => (find(models, name) as Mesh).geometry;
  const girth: [number, number, number] = [body.girth, 1, layout.deep ? body.girth : 1];
  /** A group at a body anchor, moved with the body when girth widens it. */
  const onBody = (name: string) => {
    const g = anchored(group, find(models, `body_${spec.pose}__${name}`));
    g.position.multiply(new Vector3(...girth));
    return g;
  };

  // --- Body: scaled about its own centre so breathing does not lift it off the floor ---
  const bodyGeo = geometryOf(`body_${spec.pose}`);
  const centre = bodyGeo.boundingBox!.getCenter(new Vector3());
  const bodyGroup = new Group();
  bodyGroup.position.set(0, centre.y, centre.z * girth[2]);
  group.add(bodyGroup);
  const bodyMesh = kit.add(bodyGroup, bodyGeo, fur, { shared: true });
  bodyMesh.position.set(0, -centre.y, -centre.z * girth[2]);
  bodyMesh.scale.set(...girth);

  // --- Tail ---
  const tail = new BentTail(geometryOf("tail"), body.tailFluff, layout.tail.segLen * body.tailLength);
  const tailMesh = kit.add(onBody("tail"), tail.geometry, fur);
  // Its bounds change every frame; a cat is always on screen as a whole anyway.
  tailMesh.frustumCulled = false;
  tailMesh.children.forEach((outline) => (outline.frustumCulled = false));

  // --- Head ---
  const neck = onBody("head");
  neck.scale.setScalar(body.headSize);
  const head = new Group();
  head.rotation.z = face.headTilt;
  neck.add(head);
  const skull = kit.add(head, geometryOf("head"), fur, { shared: true });
  const onHead = (name: string) => anchored(head, find(models, `head__${name}`));

  ([-1, 1] as const).forEach((side) => {
    const s = side < 0 ? "L" : "R";

    const ear = onHead(`ear_${s}`);
    ear.scale.multiplyScalar(body.earSize);
    if (face.earsFlat) {
      ear.rotateZ(-side * 0.95);
      ear.position.x += side * 0.035;
      ear.position.y -= 0.035;
    }
    kit.add(ear, geometryOf(`ear_${s}`), fur, { shared: true });

    // Eyes: a ball, an iris and a pupil, with lids and arcs doing the acting.
    const eye = onHead(`eye_${s}`);
    const shape = face.eyeShape;
    const thin = { thickness: 0.008 };
    if (shape === "closed" || shape === "happy") {
      const arc = addPart(kit, eye, find(parts, "eye_arc"), { colors: { dark: line(aroundEye(side)) } });
      if (shape === "closed") arc.rotation.z = Math.PI;
      arc.rotation.z += -side * (shape === "happy" ? 0.12 : -0.08);
    } else {
      if (shape === "wide") eye.scale.multiplyScalar(1.2);
      const iris = side < 0 ? face.eyeColorLeft : face.eyeColorRight;
      // The void has no whites: two lamps in the dark. A stoned cat's whites are not white either.
      const white = p === "solid" ? iris : vice === "stoned" ? "#F2A69B" : "#FFFFFF";
      addPart(kit, eye, find(parts, "eye_ball"), { colors: { white }, ...thin });
      const look = new Group();
      const gaze = GAZE[breed];
      if (gaze) look.position.set(-side * gaze[0], side * gaze[1], 0);
      // Drunk: each eye has its own idea of where the room is.
      if (vice === "drunk") look.position.set(side < 0 ? 0.024 : 0.004, side < 0 ? -0.012 : 0.02, 0);
      if (shape === "wide") look.scale.set(0.8, 0.8, 1);
      eye.add(look);
      addPart(kit, look, find(parts, "eye_iris"), { colors: { iris } });
      const pupil = addPart(kit, look, find(parts, "eye_pupil"), { colors: { dark: "#1A1410" } });
      const [px, py] = { slit: [0.42, 1.3], round: [1, 1], huge: [1.5, 1.45] }[face.pupil];
      pupil.scale.set(px!, py!, 1);
      addPart(kit, look, find(parts, "eye_glint"));
      if (shape === "half" || shape === "narrow") {
        // Lids take the colour of the fur around the eye.
        const around = aroundEye(side);
        const lid = find(parts, "eye_lid");
        const upper = addPart(kit, eye, lid, { colors: { fur: around }, ...thin });
        upper.position.y = shape === "half" ? 0.024 : 0.01;
        if (vice === "stoned") upper.position.y = 0.002;
        if (vice === "drunk") upper.position.y = side < 0 ? 0.03 : -0.008;
        upper.rotation.z = -side * face.browTilt * 0.9;
        if (shape === "narrow") {
          const lower = addPart(kit, eye, lid, { colors: { fur: around }, ...thin });
          lower.rotation.z = Math.PI;
          lower.position.y = -0.046;
        }
      }
    }

    if (Math.abs(face.browTilt) > 0.05) {
      const brow = addPart(kit, onHead(`brow_${s}`), find(parts, "brow"), { colors: { dark: line(aroundEye(side)) } });
      brow.rotation.z = -side * face.browTilt * 1.5;
      brow.position.x = -side * 0.012;
      if (shape === "wide") brow.position.y = 0.03;
    }

    if (vice === "drunk") addPart(kit, onHead(`eye_${s}`), find(parts, "blush"));

    if (p !== "hairless") {
      addPart(kit, onHead(`whisker_${s}`), find(parts, `whiskers_${s}`), { colors: { whisker: p === "solid" ? "#8A86A0" : "#F4EFE6", dark: line(muzzle) } });
    }
  });

  const awake = face.eyeShape !== "closed";
  const mouth = onHead("mouth");
  addPart(kit, mouth, find(parts, vice === "drunk" && awake ? "mouth_wobbly" : `mouth_${face.mouth}`), { colors: { dark: line(muzzle) } });

  // Vices: a lit joint with its smoke, or a bottle and the hiccups.
  const drifting: { part: Group; home: Vector3; rise: number; sway: number }[] = [];
  if (vice === "stoned") {
    addPart(kit, mouth, find(parts, "prop_joint"), { thickness: 0.006 });
    for (let i = 0; i < 3; i++) {
      drifting.push({ part: addPart(kit, mouth, find(parts, "prop_smoke")), home: new Vector3(0.22, -0.02, 0.11), rise: 0.36, sway: 0.05 });
    }
  } else if (vice === "drunk") {
    addPart(kit, group, find(parts, "prop_bottle"), { thickness: 0.008 }).position.set(0.2, 0, 0.36);
    const hat = onHead("hat");
    for (let i = 0; i < 2; i++) {
      drifting.push({ part: addPart(kit, hat, find(parts, "prop_bubble")), home: new Vector3(0.12, 0.02, 0.1), rise: 0.3, sway: 0.03 });
    }
  }

  // Glitch: offset wireframe echoes of the main volumes
  const echoes: Mesh[] = [];
  if (p === "glitch") {
    for (const src of [bodyMesh, skull]) {
      for (const color of [body.furSecondary, body.furTertiary]) {
        const mat = new MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.16 });
        kit.materials.push(mat);
        const echo = new Mesh(src.geometry, mat);
        echo.scale.copy(src.scale);
        src.parent!.add(echo);
        echoes.push(echo);
      }
    }
  }

  const collar = onBody("neck");
  collar.scale.multiplyScalar(body.headSize);
  addAccessory(kit, spec.accessory, parts, { neck: collar, face: onHead("face"), eye_R: onHead("eye_R"), hat: onHead("hat") });

  const anim = spec.animation;
  const baseY = anim.float ? 0.32 : 0;
  const { curl, curlAxis } = layout.tail;
  const echoHome = echoes.map((echo) => echo.position.clone());

  return {
    group,
    update(time) {
      const breathe = Math.sin(time * anim.breatheSpeed) * 0.018;
      bodyGroup.scale.set(1 + breathe, 1 + breathe * 0.6, 1 + breathe);
      group.position.y =
        baseY + (anim.float ? Math.sin(time * 1.1) * 0.05 : 0) + Math.abs(Math.sin(time * 7)) * anim.bounce;
      if (vice === "drunk" && awake) {
        // A slow list to one side, and a hiccup every couple of seconds.
        const hiccup = time % 2.3;
        group.position.y += hiccup < 0.16 ? Math.sin((hiccup / 0.16) * Math.PI) * 0.035 : 0;
        group.rotation.z = Math.sin(time * 1.2) * 0.06;
      }
      drifting.forEach(({ part, home, rise, sway }, i) => {
        // Each puff rises, swells and thins out, then starts again.
        const phase = (time * 0.32 + i / drifting.length) % 1;
        part.position.set(home.x + phase * sway * 2.5 + Math.sin(phase * 5 + i * 2.1) * sway * 0.4, home.y + phase * rise, home.z);
        part.scale.setScalar(Math.sin(Math.PI * phase) * (0.4 + phase * 0.8));
      });
      tail.bend((i) => {
        const k = i / (TAIL_SEGMENTS - 1);
        const sway = Math.sin(time * anim.tailSpeed - i * 0.55) * anim.tailAmplitude * (0.3 + k);
        if (curlAxis === "x") return [i === 0 ? 0 : curl, sway * 0.5];
        return [0, i === 0 ? 0 : curl + sway * 0.15];
      });
      head.rotation.y = Math.sin(time * 0.6) * (vice === "none" ? 0.05 : 0.11);
      if (echoes.length) {
        // Quantised jitter: echoes jump a few times per second instead of drifting.
        const tick = Math.floor(time * 9);
        echoes.forEach((echo, i) => {
          const n = Math.sin(tick * 12.9898 + i * 78.233) * 43758.5453;
          const f = n - Math.floor(n);
          echo.position.copy(echoHome[i]!);
          echo.position.x += (i % 2 ? 1 : -1) * (0.02 + f * 0.05);
          echo.position.y += (f - 0.5) * 0.03;
        });
      }
    },
  };
}

/**
 * Turns a CatSpec into an animated three.js cat. Origin at the floor, facing +z.
 * The meshes come from the Blender kit, which loads in the background: the group is
 * returned immediately and fills in when `ready` resolves.
 */
export function createCat(spec: CatSpec, opts: CatOptions = {}): CatObject {
  const group = new Group();
  group.name = `cat:${spec.seed}`;
  const mode = spec.render.ghost ? "ghost" : "toon";
  const assets = opts.assets ?? catAssetLibrary();
  const kits: Kit[] = [];
  const forms: Form[] = [];
  const worldPos = new Vector3();
  let disposed = false;

  const bodies = spec.altBody ? [spec.body, spec.altBody] : [spec.body];
  const breeds = bodies.map((body, i) => breedOf(body, i === 0 ? spec.traits.breed.variant : undefined));
  const ready = Promise.all([assets.shared("cat-kit"), ...breeds.map((b) => assets.shared(`cat-${b}`))]).then(([parts, ...models]) => {
    if (disposed) return;
    const missing = [parts!, ...models].find(isPlaceholder);
    if (missing) {
      group.add(missing.clone());
      return;
    }
    prepareKit(parts!);
    bodies.forEach((body, i) => {
      const kit = new Kit(mode, body.outline, spec.render.opacity);
      const form = buildForm(spec, body, breeds[i]!, kit, parts!, prepareKit(models[i]!));
      kits.push(kit);
      forms.push(form);
      group.add(form.group);
    });
  });

  return {
    group,
    ready,
    update(time) {
      if (mode === "ghost") {
        // Wisps fray towards wherever this cat's floor is, wherever it has been placed.
        const floor = group.getWorldPosition(worldPos).y;
        for (const kit of kits) {
          for (const g of kit.ghostMaterials) {
            g.uniforms.uTime!.value = time;
            g.uniforms.uFloor!.value = floor;
          }
        }
      }
      if (forms.length === 2) {
        // Quantum flicker: mostly form A, with irregular bursts of form B.
        const slow = Math.sin(time * 0.9) + Math.sin(time * 2.3 + 1.7);
        const burst = Math.sin(time * 31) > 0.2;
        const showAlt = slow > 0.9 ? true : slow > 0.4 ? burst : false;
        forms[0]!.group.visible = !showAlt;
        forms[1]!.group.visible = showAlt;
        const switching = slow > 0.4 && slow <= 0.9;
        group.position.x = switching ? Math.sin(time * 90) * 0.015 : 0;
        group.scale.setScalar(switching ? 1 + Math.sin(time * 70) * 0.02 : 1);
      }
      for (const form of forms) if (form.group.visible) form.update(time);
    },
    dispose() {
      disposed = true;
      for (const kit of kits) kit.dispose();
    },
  };
}
