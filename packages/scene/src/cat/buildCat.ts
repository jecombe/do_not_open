import {
  CapsuleGeometry,
  CircleGeometry,
  ConeGeometry,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  CylinderGeometry,
} from "three";
import type { CatBody, CatSpec, Pose } from "@dno/generator";
import { Kit } from "../materials";
import { addAccessory } from "./accessories";

export interface CatObject {
  group: Group;
  /** Advance animations. `time` in seconds. */
  update(time: number): void;
  dispose(): void;
}

type V3 = [number, number, number];

interface PoseLayout {
  body: { pos: V3; r: V3; rotX: number };
  head: { pos: V3; rot: V3 };
  legs: "standing" | "stretched" | "none";
  hindFeet: boolean;
  belly: boolean;
  /** Axis the long side of the body runs along, which decides how stripes wrap. */
  bodyAxis: "y" | "z";
  tail: { pos: V3; rot: V3; curlAxis: "x" | "z"; curl: number; segLen: number };
}

const POSES: Record<Pose, PoseLayout> = {
  sit: {
    body: { pos: [0, 0.4, -0.02], r: [0.3, 0.4, 0.29], rotX: 0 },
    head: { pos: [0, 0.92, 0.12], rot: [0, 0, 0] },
    legs: "standing",
    hindFeet: true,
    belly: true,
    bodyAxis: "y",
    tail: { pos: [0.08, 0.1, -0.22], rot: [-1.2, 0, -0.95], curlAxis: "x", curl: 0.24, segLen: 0.125 },
  },
  loaf: {
    body: { pos: [0, 0.25, 0], r: [0.31, 0.25, 0.42], rotX: 0 },
    head: { pos: [0, 0.5, 0.36], rot: [0, 0, 0] },
    legs: "none",
    hindFeet: false,
    belly: false,
    bodyAxis: "z",
    tail: { pos: [0.16, 0.08, -0.36], rot: [-Math.PI / 2, 0, 0.5], curlAxis: "z", curl: -0.4, segLen: 0.12 },
  },
  crouch: {
    body: { pos: [0, 0.29, 0], r: [0.27, 0.23, 0.42], rotX: 0.24 },
    head: { pos: [0, 0.36, 0.46], rot: [0.1, 0, 0] },
    legs: "stretched",
    hindFeet: true,
    belly: false,
    bodyAxis: "z",
    tail: { pos: [0, 0.42, -0.36], rot: [-0.45, 0, 0], curlAxis: "x", curl: 0.1, segLen: 0.1 },
  },
  curl: {
    body: { pos: [0, 0.2, 0], r: [0.43, 0.2, 0.36], rotX: 0 },
    head: { pos: [0.2, 0.23, 0.29], rot: [0.15, -0.35, -0.3] },
    legs: "none",
    hindFeet: false,
    belly: false,
    bodyAxis: "z",
    tail: { pos: [-0.3, 0.08, -0.22], rot: [-Math.PI / 2, 0, -1.2], curlAxis: "z", curl: 0.42, segLen: 0.13 },
  },
  float: {
    body: { pos: [0, 0.25, 0], r: [0.31, 0.25, 0.42], rotX: 0 },
    head: { pos: [0, 0.5, 0.36], rot: [0, 0, 0] },
    legs: "none",
    hindFeet: false,
    belly: false,
    bodyAxis: "z",
    tail: { pos: [0, 0.2, -0.4], rot: [-1.1, 0, 0], curlAxis: "x", curl: 0.3, segLen: 0.1 },
  },
};

const UP = new Vector3(0, 1, 0);

/** Spherical patch hugging an ellipsoid. phi: 0 = -x, PI/2 = +z, PI = +x. theta: 0 = top. */
function patch(kit: Kit, parent: Object3D, r: V3, color: string, phi: [number, number], theta: [number, number]) {
  const geo = new SphereGeometry(1, 20, 14, phi[0], phi[1], theta[0], theta[1]);
  geo.scale(r[0] * 1.02, r[1] * 1.02, r[2] * 1.02);
  return kit.add(parent, geo, kit.fur(color), { outline: false, shadow: false });
}

const FRONT = Math.PI / 2;
const BACK = (3 * Math.PI) / 2;

interface Form {
  group: Group;
  update(time: number): void;
}

function buildForm(spec: CatSpec, body: CatBody, kit: Kit): Form {
  const layout = POSES[spec.pose];
  const group = new Group();
  const p = body.pattern;
  const R = 0.27 * body.headSize;
  const br: V3 = [layout.body.r[0] * body.girth, layout.body.r[1], layout.body.r[2] * (layout.bodyAxis === "y" ? body.girth : 1)];
  const pawColor = p === "tuxedo" || p === "points" ? body.furSecondary : p === "calico" ? body.furBase : body.furBase;
  const faceColor = body.furBase;
  const fur = kit.fur(body.furBase);

  // --- Body ---
  const bodyGroup = new Group();
  bodyGroup.position.set(...layout.body.pos);
  bodyGroup.rotation.x = layout.body.rotX;
  group.add(bodyGroup);

  let bodyGeo;
  if (p === "loaf") {
    bodyGeo = new CapsuleGeometry(br[1], Math.max(0.05, 2 * (br[2] - br[1])), 6, 14);
    bodyGeo.rotateX(Math.PI / 2);
    bodyGeo.scale(br[0] / br[1], 1.05, 1);
  } else {
    bodyGeo = new SphereGeometry(1, 24, 18);
    bodyGeo.scale(...br);
  }
  const bodyMesh = kit.add(bodyGroup, bodyGeo, fur);

  if (p === "loaf") {
    for (let i = -1; i <= 1; i++) {
      const slash = kit.add(bodyGroup, new BoxGeometry(0.26, 0.02, 0.035), kit.fur(body.furTertiary), { outline: false });
      slash.position.set(0, br[1] * 1.04, i * 0.17);
      slash.rotation.y = 0.5;
    }
  }

  if (layout.belly && p !== "solid" && p !== "loaf" && p !== "glitch") {
    const wide = p === "tuxedo";
    patch(kit, bodyGroup, br, body.furBelly, [FRONT - (wide ? 0.75 : 0.55), wide ? 1.5 : 1.1], [wide ? 0.35 : 0.7, wide ? 2.2 : 1.8]);
  }

  if (p === "tabby") {
    const stripe = kit.fur(body.furSecondary);
    for (const off of [-0.32, 0, 0.32]) {
      if (layout.bodyAxis === "y") {
        const dy = off * br[1] + 0.06;
        const ring = br[0] * Math.sqrt(1 - (dy / br[1]) ** 2);
        const geo = new TorusGeometry(ring, 0.02, 6, 20, Math.PI * 0.9);
        geo.rotateZ(Math.PI * 0.05);
        geo.scale(1, br[2] / br[0], 1);
        geo.rotateX(-Math.PI / 2);
        kit.add(bodyGroup, geo, stripe, { outline: false }).position.y = dy;
      } else {
        const dz = off * br[2];
        const ring = br[0] * Math.sqrt(1 - (dz / br[2]) ** 2);
        const geo = new TorusGeometry(ring, 0.02, 6, 20, Math.PI * 0.8);
        geo.rotateZ(Math.PI * 0.1);
        geo.scale(1, br[1] / br[0], 1);
        kit.add(bodyGroup, geo, stripe, { outline: false }).position.z = dz;
      }
    }
  }

  if (p === "calico") {
    patch(kit, bodyGroup, br, body.furSecondary, [BACK - 1.2, 1.1], [0.2, 1.1]);
    patch(kit, bodyGroup, br, body.furTertiary, [BACK + 0.2, 1.0], [0.5, 1.2]);
    patch(kit, bodyGroup, br, body.furSecondary, [Math.PI - 0.5, 0.9], [1.3, 1.0]);
    patch(kit, bodyGroup, br, body.furTertiary, [-0.3, 0.8], [1.2, 1.0]);
  }

  // --- Legs and feet ---
  const paw = kit.fur(pawColor);
  if (layout.legs === "standing") {
    for (const side of [-1, 1]) {
      kit.add(group, new CapsuleGeometry(0.055, 0.26, 4, 10), fur).position.set(side * 0.11, 0.2, 0.2);
      const foot = new SphereGeometry(0.07, 12, 10);
      foot.scale(1, 0.7, 1.25);
      kit.add(group, foot, paw).position.set(side * 0.11, 0.05, 0.25);
    }
  } else if (layout.legs === "stretched") {
    for (const side of [-1, 1]) {
      const leg = new CapsuleGeometry(0.055, 0.24, 4, 10);
      leg.rotateX(Math.PI / 2);
      kit.add(group, leg, fur).position.set(side * 0.13, 0.06, 0.5);
      const foot = new SphereGeometry(0.068, 12, 10);
      foot.scale(1, 0.75, 1.2);
      kit.add(group, foot, paw).position.set(side * 0.13, 0.055, 0.67);
    }
  }
  if (layout.hindFeet) {
    for (const side of [-1, 1]) {
      const foot = new SphereGeometry(0.085, 12, 10);
      foot.scale(1, 0.6, 1.5);
      kit.add(group, foot, paw).position.set(side * (br[0] * 0.78), 0.05, 0.1);
    }
  }

  // --- Tail: a chain of joints so it can sway ---
  const tailColor = p === "points" ? body.furSecondary : body.furBase;
  const joints: Group[] = [];
  const tailRoot = new Group();
  tailRoot.position.set(...layout.tail.pos);
  tailRoot.rotation.set(...layout.tail.rot);
  group.add(tailRoot);
  const segments = 7;
  const segLen = layout.tail.segLen * body.tailLength;
  let parent: Object3D = tailRoot;
  for (let i = 0; i < segments; i++) {
    const joint = new Group();
    if (i > 0) joint.position.y = segLen;
    parent.add(joint);
    joints.push(joint);
    const radius = 0.048 * body.tailFluff * (1 - 0.3 * (i / segments));
    const geo = new CapsuleGeometry(radius, segLen, 3, 8);
    geo.translate(0, segLen / 2, 0);
    let color = tailColor;
    if (p === "tabby" && i % 2 === 1) color = body.furSecondary;
    if (p === "tuxedo" && i === segments - 1) color = body.furSecondary;
    if (p === "calico" && i >= segments - 3) color = body.furTertiary;
    kit.add(joint, geo, kit.fur(color));
    parent = joint;
  }

  // --- Head ---
  const head = new Group();
  head.position.set(...layout.head.pos);
  head.rotation.set(layout.head.rot[0], layout.head.rot[1], layout.head.rot[2] + spec.face.headTilt);
  group.add(head);
  const hr: V3 = [R * 1.1, R * 0.92, R * 0.95];
  const skullGeo = new SphereGeometry(1, 24, 18);
  skullGeo.scale(...hr);
  const skull = kit.add(head, skullGeo, fur);

  if (p === "points") patch(kit, head, hr, body.furSecondary, [FRONT - 0.6, 1.2], [1.05, 1.15]);
  if (p === "tuxedo") patch(kit, head, hr, body.furSecondary, [FRONT - 0.45, 0.9], [1.45, 1.5]);
  if (p === "calico") {
    patch(kit, head, hr, body.furSecondary, [FRONT + 0.1, 1.2], [0.15, 1.1]);
    patch(kit, head, hr, body.furTertiary, [FRONT - 1.5, 1.1], [0.2, 0.9]);
  }
  if (p === "tabby") {
    for (const x of [-0.22, 0, 0.22]) {
      const mark = kit.add(head, new BoxGeometry(R * 0.09, R * 0.34, R * 0.06), kit.fur(body.furSecondary), { outline: false });
      const y = R * 0.66;
      mark.position.set(x * R, y, Math.sqrt(Math.max(0, 1 - (y / hr[1]) ** 2 - ((x * R) / hr[0]) ** 2)) * hr[2]);
      mark.rotation.x = -0.75;
    }
  }
  if (p === "hairless") {
    for (let i = 0; i < 3; i++) {
      const wrinkle = new TorusGeometry(R * (0.2 + i * 0.07), R * 0.018, 5, 12, Math.PI * 0.7);
      wrinkle.rotateZ(Math.PI * 0.15);
      const m = kit.add(head, wrinkle, kit.fur(body.furSecondary), { outline: false });
      m.position.set(0, R * 0.42, R * 0.78);
      m.rotation.x = -0.55;
    }
  }

  // Ears
  const earColor = p === "points" ? body.furSecondary : p === "calico" ? body.furSecondary : body.furBase;
  for (const side of [-1, 1]) {
    const ear = new Group();
    const flat = spec.face.earsFlat;
    ear.position.set(side * R * (flat ? 0.8 : 0.6), R * (flat ? 0.55 : 0.72), 0);
    ear.rotation.z = -side * (flat ? 1.15 : 0.3);
    head.add(ear);
    const e = body.earSize;
    if (body.earShape === "round") {
      const geo = new SphereGeometry(R * 0.26 * e, 12, 10);
      geo.scale(1, 1, 0.5);
      kit.add(ear, geo, kit.fur(earColor)).position.y = R * 0.08;
    } else {
      const h = R * 0.62 * e;
      const geo = new ConeGeometry(R * 0.36 * e, h, 14);
      geo.scale(1, 1, 0.55);
      geo.translate(0, h / 2 - R * 0.08, 0);
      kit.add(ear, geo, kit.fur(earColor));
      const inner = new ConeGeometry(R * 0.22 * e, h * 0.68, 12);
      inner.scale(1, 1, 0.4);
      inner.translate(0, h * 0.34 - R * 0.06, R * 0.075 * e);
      kit.add(ear, inner, kit.fur(body.skin), { outline: false });
      if (body.earShape === "tufted") {
        const tuft = new ConeGeometry(R * 0.06, R * 0.3, 6);
        tuft.translate(0, h + R * 0.02, 0);
        kit.add(ear, tuft, kit.fur(body.furSecondary), { outline: false });
      }
    }
  }

  // Muzzle, nose, mouth
  const dark = kit.flat(p === "solid" ? "#4A4560" : "#1A1410");
  const muzzleColor = p === "tuxedo" ? body.furSecondary : p === "points" ? body.furSecondary : body.furBelly;
  for (const side of [-1, 1]) {
    const geo = new SphereGeometry(R * 0.2, 12, 10);
    geo.scale(1.1, 0.85, 0.7);
    kit.add(head, geo, kit.fur(muzzleColor), { outline: false }).position.set(side * R * 0.14, -R * 0.24, R * 0.86);
  }
  const noseGeo = new SphereGeometry(R * 0.075, 8, 6);
  noseGeo.scale(1.35, 0.85, 0.8);
  kit.add(head, noseGeo, kit.fur(body.skin), { outline: false }).position.set(0, -R * 0.13, R * 1.0);

  const mouthAt = (m: Object3D) => m.position.set(0, -R * 0.4, R * 0.93);
  const arc = (rot: number, x = 0) => {
    const geo = new TorusGeometry(R * 0.13, R * 0.022, 5, 12, Math.PI);
    geo.rotateZ(rot);
    const m = kit.add(head, geo, dark, { outline: false });
    mouthAt(m);
    m.position.x = x;
    return m;
  };
  switch (spec.face.mouth) {
    case "smile":
      arc(Math.PI);
      break;
    case "frown":
      arc(0).position.y -= R * 0.1;
      break;
    case "smirk":
      arc(Math.PI + 0.45, R * 0.08);
      break;
    case "open": {
      const geo = new SphereGeometry(R * 0.13, 12, 8);
      geo.scale(1, 1.1, 0.35);
      mouthAt(kit.add(head, geo, dark, { outline: false }));
      const tongue = new SphereGeometry(R * 0.08, 10, 8);
      tongue.scale(1, 0.8, 0.35);
      const t = kit.add(head, tongue, kit.flat("#E8707A"), { outline: false });
      mouthAt(t);
      t.position.y -= R * 0.06;
      t.position.z += R * 0.03;
      break;
    }
    case "neutral":
      break;
  }

  // Whiskers
  if (p !== "hairless") {
    const whisker = kit.flat(p === "solid" ? "#8A86A0" : "#F4EFE6");
    for (const side of [-1, 1]) {
      for (let i = -1; i <= 1; i++) {
        const geo = new CylinderGeometry(R * 0.008, R * 0.008, R * 0.75, 4);
        geo.translate(0, R * 0.375, 0);
        const w = kit.add(head, geo, whisker, { outline: false, shadow: false });
        w.position.set(side * R * 0.3, -R * 0.22, R * 0.82);
        w.rotation.set(0.35, 0, -side * (Math.PI / 2 + i * 0.22));
      }
    }
  }

  // Eyes
  const lid = kit.flat(p === "points" ? body.furSecondary : faceColor, { doubleSide: true });
  const white = kit.flat("#FFFFFF");
  ([-1, 1] as const).forEach((side) => {
    const eye = new Group();
    eye.position.set(side * R * 0.42, R * 0.1, R * 0.84);
    eye.rotation.y = side * 0.42;
    head.add(eye);
    const shape = spec.face.eyeShape;
    const layer = (geo: CircleGeometry | TorusGeometry | BoxGeometry, mat: ReturnType<Kit["flat"]>, z: number) => {
      const m = kit.add(eye, geo, mat, { outline: false, shadow: false });
      m.position.z = z * R;
      return m;
    };

    if (shape === "closed" || shape === "happy") {
      const geo = new TorusGeometry(R * 0.17, R * 0.028, 5, 12, Math.PI);
      if (shape === "closed") geo.rotateZ(Math.PI);
      layer(geo, dark, 0.05).position.y = shape === "closed" ? R * 0.06 : -R * 0.04;
    } else {
      const ir = R * 0.22 * (shape === "wide" ? 1.2 : 1);
      const iris = kit.flat(side < 0 ? spec.face.eyeColorLeft : spec.face.eyeColorRight);
      layer(new CircleGeometry(ir * 1.12, 20), dark, 0.03);
      layer(new CircleGeometry(ir, 20), iris, 0.04);
      const pupilScale = { slit: [0.22, 0.85], round: [0.5, 0.5], huge: [0.8, 0.8] }[spec.face.pupil] as [number, number];
      layer(new CircleGeometry(ir, 16), dark, 0.05).scale.set(pupilScale[0], pupilScale[1], 1);
      const glint = layer(new CircleGeometry(ir * 0.2, 8), white, 0.06);
      glint.position.x = -ir * 0.35;
      glint.position.y = ir * 0.4;
      if (shape === "half" || shape === "narrow") {
        const cover = shape === "half" ? 0.12 : 0.26;
        layer(new CircleGeometry(ir * 1.25, 16, 0, Math.PI), lid, 0.07).position.y = ir * cover;
        if (shape === "narrow") {
          layer(new CircleGeometry(ir * 1.25, 16, Math.PI, Math.PI), lid, 0.07).position.y = -ir * 0.38;
        }
      }
    }
    if (Math.abs(spec.face.browTilt) > 0.05) {
      const brow = layer(new BoxGeometry(R * 0.4, R * 0.06, R * 0.02), dark, 0.09);
      brow.position.y = R * 0.34;
      brow.rotation.z = -side * spec.face.browTilt;
    }
  });

  // Mane
  if (body.mane) {
    const q = new Quaternion();
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2;
      const dir = new Vector3(Math.cos(a), -0.55, Math.sin(a)).normalize();
      const geo = new ConeGeometry(R * 0.3, R * 0.85, 7);
      geo.translate(0, R * 0.3, 0);
      const tuft = kit.add(head, geo, kit.fur(body.furBelly));
      tuft.position.set(Math.cos(a) * R * 0.55, -R * 0.55, Math.sin(a) * R * 0.5 - R * 0.1);
      tuft.quaternion.copy(q.setFromUnitVectors(UP, dir));
    }
  }

  // Glitch: offset wireframe echoes of the main volumes
  const echoes: Mesh[] = [];
  if (p === "glitch") {
    for (const [src, holder] of [[bodyMesh, bodyGroup], [skull, head]] as const) {
      for (const color of [body.furSecondary, body.furTertiary]) {
        const mat = new MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.7 });
        kit.materials.push(mat);
        const echo = new Mesh(src.geometry, mat);
        holder.add(echo);
        echoes.push(echo);
      }
    }
  }

  const neck = new Group();
  neck.position.set(layout.head.pos[0], layout.head.pos[1] - R * 0.78, layout.head.pos[2] - R * 0.12);
  neck.rotation.set(...layout.head.rot);
  group.add(neck);
  addAccessory(kit, spec.accessory, { head, neck, R });

  const anim = spec.animation;
  const baseY = anim.float ? 0.32 : 0;
  const curl = layout.tail.curl;

  return {
    group,
    update(time) {
      const breathe = Math.sin(time * anim.breatheSpeed) * 0.018;
      bodyGroup.scale.set(1 + breathe, 1 + breathe * 0.6, 1 + breathe);
      group.position.y =
        baseY + (anim.float ? Math.sin(time * 1.1) * 0.05 : 0) + Math.abs(Math.sin(time * 7)) * anim.bounce;
      joints.forEach((joint, i) => {
        const k = i / (joints.length - 1);
        const sway = Math.sin(time * anim.tailSpeed - i * 0.55) * anim.tailAmplitude * (0.3 + k);
        if (layout.tail.curlAxis === "x") {
          joint.rotation.x = i === 0 ? 0 : curl;
          joint.rotation.z = sway * 0.5;
        } else {
          joint.rotation.z = i === 0 ? 0 : curl + sway * 0.15;
        }
      });
      head.rotation.y = layout.head.rot[1] + Math.sin(time * 0.6) * 0.05;
      if (echoes.length) {
        // Quantised jitter: echoes jump a few times per second instead of drifting.
        const tick = Math.floor(time * 9);
        echoes.forEach((echo, i) => {
          const n = Math.sin(tick * 12.9898 + i * 78.233) * 43758.5453;
          const f = n - Math.floor(n);
          echo.position.set((i % 2 ? 1 : -1) * (0.02 + f * 0.05), (f - 0.5) * 0.03, 0);
        });
      }
    },
  };
}

/** Turns a CatSpec into an animated three.js cat. Origin at the floor, facing +z. */
export function createCat(spec: CatSpec): CatObject {
  const group = new Group();
  group.name = `cat:${spec.seed}`;
  const mode = spec.render.ghost ? "ghost" : "toon";
  const kits: Kit[] = [];
  const forms: Form[] = [];
  const worldPos = new Vector3();

  for (const body of spec.altBody ? [spec.body, spec.altBody] : [spec.body]) {
    const kit = new Kit(mode, body.outline, spec.render.opacity);
    const form = buildForm(spec, body, kit);
    kits.push(kit);
    forms.push(form);
    group.add(form.group);
  }

  return {
    group,
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
      for (const kit of kits) kit.dispose();
    },
  };
}
