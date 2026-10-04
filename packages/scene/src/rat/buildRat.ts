import {
  BoxGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from "three";
import type { RatSpec } from "@dno/generator";
import { Kit } from "../materials";

export interface RatObject {
  group: Group;
  /** Advance animations. `time` in seconds. */
  update(time: number): void;
  dispose(): void;
  /** Resolves at once: a rat is all geometry, nothing to load. Same shape as a cat for the stage. */
  ready: Promise<void>;
}

const THIN = { thickness: 0.006 };
const FINE = { thickness: 0.004 };

/** A pear: wide at the hips, narrow at the shoulders. Height 1, widest radius 1, origin at the floor. */
function pear(): LatheGeometry {
  const pts: Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const y = t;
    // Round bottom, belly bulge low, narrowing to the neck.
    const r = Math.sin(Math.PI * Math.min(1, t * 1.02)) ** 0.7 * (1 - 0.42 * t) * (t < 0.08 ? Math.sqrt(t / 0.08) : 1);
    pts.push(new Vector2(Math.max(0.001, r), y));
  }
  return new LatheGeometry(pts, 32);
}

function cheeseWedge(): ExtrudeGeometry {
  const s = new Shape();
  s.moveTo(0, 0);
  s.lineTo(0.22, 0.06);
  s.lineTo(0.22, -0.06);
  s.lineTo(0, 0);
  const g = new ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 1 });
  g.center();
  return g;
}

/**
 * Turns a RatSpec into an animated three.js rat, drawn with the game's toon materials and
 * outline. Origin at the floor, facing +z, about as tall as a cat.
 */
export function createRat(spec: RatSpec): RatObject {
  const c = spec.colors;
  const b = spec.body;
  const kit = new Kit("toon", c.outline);
  const fur = kit.fur(c.fur);
  const patch = kit.fur(c.patch);
  const belly = kit.fur(c.belly);
  const skin = kit.fur(c.skin);
  const white = kit.fur("#FFFDF6");
  const dark = kit.flat("#1A1410");
  const hooded = spec.coat === "hooded";

  const group = new Group();
  group.name = `rat:${spec.seed}`;
  const rig = new Group();
  group.add(rig);

  const lean = spec.pose === "sniff" ? 0.38 : spec.pose === "stand" ? -0.05 : 0.08;
  const tall = (spec.pose === "stand" ? 1.18 : 1) * b.height;

  // --- Body ---
  const torso = new Group();
  torso.rotation.x = lean;
  rig.add(torso);
  const bodyH = 0.62 * tall;
  const bodyR = 0.3 * b.girth;
  const bodyMesh = kit.add(torso, pear(), fur);
  bodyMesh.scale.set(bodyR, bodyH, bodyR * 0.92);
  const tummy = kit.add(torso, new SphereGeometry(1, 24, 16), belly, THIN);
  tummy.scale.set(bodyR * 0.66, bodyH * 0.32, bodyR * 0.3);
  tummy.position.set(0, bodyH * 0.34, bodyR * 0.66);
  if (spec.coat === "patched") {
    for (const [x, y, z, r] of [
      [0.6, 0.55, -0.3, 0.42],
      [-0.55, 0.3, 0.2, 0.32],
    ] as const) {
      const spot = kit.add(torso, new SphereGeometry(1, 16, 12), patch, { outline: false });
      spot.scale.set(bodyR * r, bodyH * r * 0.6, bodyR * r * 0.5);
      spot.position.set(bodyR * x * 0.82, bodyH * y, bodyR * z * 1.2);
    }
  }
  if (hooded) {
    const shoulders = kit.add(torso, new SphereGeometry(1, 24, 16), patch, { outline: false });
    shoulders.scale.set(bodyR * 0.78, bodyH * 0.22, bodyR * 0.76);
    shoulders.position.set(0, bodyH * 0.86, -bodyR * 0.04);
  }

  // Haunches and big pink feet.
  ([-1, 1] as const).forEach((side) => {
    const haunch = kit.add(rig, new SphereGeometry(1, 20, 14), fur, THIN);
    haunch.scale.set(0.13 * b.girth, 0.12, 0.16);
    haunch.position.set(side * bodyR * 0.72, 0.12, 0.02);
    const foot = kit.add(rig, new SphereGeometry(1, 16, 10), skin, THIN);
    foot.scale.set(0.07, 0.035, 0.13);
    foot.position.set(side * bodyR * 0.62, 0.03, 0.17 + bodyR * 0.3);
    for (let i = -1; i <= 1; i++) {
      const toe = kit.add(rig, new SphereGeometry(0.022, 10, 8), skin, FINE);
      toe.position.set(side * bodyR * 0.62 + i * 0.035, 0.03, 0.3 + bodyR * 0.3);
    }
  });

  // --- Tail: a long pink rope curling on the floor, swinging from its root ---
  const tailRoot = new Group();
  tailRoot.position.set(0, 0.07, -bodyR * 0.85);
  rig.add(tailRoot);
  const L = 1.1 * b.tail;
  const tailCurve = new CatmullRomCurve3([
    new Vector3(0, 0, 0),
    new Vector3(0.05, -0.04, -0.22 * L),
    new Vector3(0.28 * L, -0.05, -0.42 * L),
    new Vector3(0.55 * L, -0.03, -0.3 * L),
    new Vector3(0.62 * L, 0.06, -0.05 * L),
    new Vector3(0.5 * L, 0.2, 0.05 * L),
  ]);
  const tailGeo = new TubeGeometry(tailCurve, 48, 0.03, 8, false);
  // Taper towards the tip.
  const tp = tailGeo.getAttribute("position");
  const centre = new Vector3();
  for (let i = 0; i < tp.count; i++) {
    const seg = Math.floor(i / 9) / 48;
    tailCurve.getPointAt(Math.min(1, seg), centre);
    const k = 1 - seg * 0.75;
    tp.setXYZ(i, centre.x + (tp.getX(i) - centre.x) * k, centre.y + (tp.getY(i) - centre.y) * k, centre.z + (tp.getZ(i) - centre.z) * k);
  }
  tailGeo.computeVertexNormals();
  kit.add(tailRoot, tailGeo, skin, THIN);

  // --- Head ---
  const neck = new Group();
  neck.position.set(0, bodyH * 0.96, bodyR * 0.08);
  torso.add(neck);
  const head = new Group();
  head.rotation.x = -lean * 0.7;
  head.scale.setScalar(b.head * 1.22);
  neck.add(head);
  const headFur = hooded ? patch : fur;
  const skull = kit.add(head, new SphereGeometry(0.2, 32, 24), headFur);
  skull.scale.set(1.05, 0.95, 1);
  skull.position.y = 0.12;

  // The snout: a long rounded cone, with a pink nose on the end.
  const snout = new Group();
  snout.position.set(0, 0.08, 0.14);
  head.add(snout);
  const muzzle = kit.add(snout, new SphereGeometry(0.1, 24, 16), headFur);
  muzzle.scale.set(0.92, 0.8, 2.1 * b.snout);
  muzzle.position.z = 0.09 * b.snout;
  const tip = new Group();
  tip.position.set(0, -0.005, 0.28 * b.snout);
  snout.add(tip);
  kit.add(tip, new SphereGeometry(0.042, 16, 12), skin, THIN);
  ([-1, 1] as const).forEach((side) => {
    const cheek = kit.add(snout, new SphereGeometry(0.05, 14, 10), kit.flat(c.skin, { opacity: 0.55 }), { outline: false });
    cheek.scale.set(1, 0.6, 0.4);
    cheek.position.set(side * 0.085, -0.005, 0.08);
  });

  // Whiskers: three a side, from the snout's sides.
  const whiskers: Group[] = [];
  ([-1, 1] as const).forEach((side) => {
    const w = new Group();
    w.position.set(side * 0.05, 0.0, 0.24 * b.snout);
    snout.add(w);
    whiskers.push(w);
    for (let i = 0; i < 3; i++) {
      const hair = kit.add(w, new CylinderGeometry(0.003, 0.003, 0.2, 4), kit.flat(spec.coat === "black" ? "#C9C2CC" : "#3A3036"), { outline: false });
      hair.rotation.z = side * (Math.PI / 2 + (i - 1) * 0.22);
      hair.position.x = side * 0.1;
      hair.position.y = (i - 1) * 0.012;
    }
  });

  // Teeth: two buck teeth, the rat's whole personality.
  const mouth = new Group();
  mouth.position.set(0, -0.05, 0.25 * b.snout);
  snout.add(mouth);
  const teethSize = (spec.face === "teeth" ? 1.5 : 1) * b.teeth;
  if (spec.face !== "shock") {
    ([-1, 1] as const).forEach((side) => {
      const tooth = kit.add(mouth, new BoxGeometry(0.026, 0.04 * teethSize, 0.012), white, FINE);
      tooth.position.set(side * 0.015, -0.02 * teethSize, 0.02);
    });
  }
  if (spec.face === "grin" || spec.face === "smug") {
    const smile = kit.add(mouth, new TorusGeometry(0.04, 0.006, 6, 16, Math.PI), dark, { outline: false });
    smile.rotation.z = Math.PI;
    smile.position.set(0, 0.012, 0.012);
    if (spec.face === "smug") {
      smile.rotation.z = Math.PI + 0.35;
      smile.scale.set(0.8, 0.5, 1);
    }
  } else if (spec.face === "tongue") {
    const tongue = kit.add(mouth, new SphereGeometry(0.03, 12, 8), kit.fur("#E8607A"), FINE);
    tongue.scale.set(0.8, 0.4, 1.1);
    tongue.position.set(0.02, -0.05, 0.03);
  } else if (spec.face === "shock") {
    const o = kit.add(mouth, new SphereGeometry(0.032, 14, 10), dark, { outline: false });
    o.scale.set(0.9, 1.2, 0.3);
    o.position.set(0, -0.02, 0.02);
  }

  // Ears: big round dishes, pink inside.
  const ears: Group[] = [];
  ([-1, 1] as const).forEach((side) => {
    const ear = new Group();
    ear.position.set(side * 0.14, 0.27, -0.01);
    ear.rotation.set(-0.15, side * 0.35, side * -0.35);
    ear.scale.setScalar(b.ears);
    head.add(ear);
    ears.push(ear);
    const dish = kit.add(ear, new CylinderGeometry(0.108, 0.108, 0.03, 28), headFur);
    dish.rotation.x = Math.PI / 2;
    const inner = kit.add(ear, new CylinderGeometry(0.076, 0.076, 0.01, 24), skin, { outline: false });
    inner.rotation.x = Math.PI / 2;
    inner.position.z = 0.016;
    if (spec.nickedEar && side > 0) {
      // A sticking plaster across the old bite.
      const plaster = kit.add(ear, new BoxGeometry(0.11, 0.035, 0.01), kit.fur("#E9C9A0"), FINE);
      plaster.position.set(0.04, 0.06, 0.024);
      plaster.rotation.z = -0.6;
    }
  });

  // Eyes.
  const eyeY = 0.16;
  const eyeX = 0.085;
  const eyeZ = 0.16;
  if (spec.eyes === "shades") {
    const shades = new Group();
    shades.position.set(0, eyeY, eyeZ + 0.02);
    head.add(shades);
    ([-1, 1] as const).forEach((side) => {
      const lens = kit.add(shades, new BoxGeometry(0.1, 0.06, 0.02), kit.fur("#15121A"), FINE);
      lens.position.x = side * 0.065;
    });
    kit.add(shades, new BoxGeometry(0.06, 0.012, 0.012), kit.fur("#15121A"), { outline: false }).position.y = 0.015;
  } else {
    ([-1, 1] as const).forEach((side) => {
      const eye = new Group();
      eye.position.set(side * eyeX, eyeY, eyeZ);
      head.add(eye);
      if (spec.eyes === "dots") {
        kit.add(eye, new SphereGeometry(0.026, 14, 10), kit.flat(c.eye), { outline: false });
        kit.add(eye, new SphereGeometry(0.008, 8, 6), kit.flat("#FFFFFF"), { outline: false }).position.set(0.008, 0.01, 0.02);
        return;
      }
      const r = spec.eyes === "big" || spec.eyes === "derp" ? 0.06 : 0.05;
      kit.add(eye, new SphereGeometry(r, 20, 14), white, FINE);
      const look = new Group();
      // A derp: each eye has its own opinion.
      if (spec.eyes === "derp") look.position.set(side < 0 ? 0.018 : 0.01, side < 0 ? -0.012 : 0.016, 0);
      eye.add(look);
      const pupil = kit.add(look, new SphereGeometry(r * 0.55, 16, 12), kit.flat(c.eye), { outline: false });
      pupil.position.z = r * 0.62;
      pupil.scale.z = 0.5;
      kit.add(look, new SphereGeometry(r * 0.18, 8, 6), kit.flat("#FFFFFF"), { outline: false }).position.set(r * 0.2, r * 0.25, r * 0.92);
      if (spec.eyes === "sleepy") {
        const lid = kit.add(eye, new SphereGeometry(r * 1.06, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), headFur, FINE);
        lid.rotation.x = 0.5;
      }
    });
  }

  // --- Arms, from the shoulders to the paws holding whatever it found ---
  const waving = spec.pose === "stand" && spec.prop === "none";
  const hands = new Group();
  hands.position.set(0, bodyH * 0.58, bodyR * 0.98);
  torso.add(hands);
  const up = new Vector3(0, 1, 0);
  const shoulders: Group[] = [];
  ([-1, 1] as const).forEach((side) => {
    const shoulder = new Group();
    shoulder.position.set(side * bodyR * 0.62, bodyH * 0.8, bodyR * 0.3);
    torso.add(shoulder);
    shoulders.push(shoulder);
    const raised = waving && side > 0;
    // Where the paw goes, from the shoulder.
    const reach = raised ? new Vector3(0.1, 0.24, 0.06) : new Vector3(side * 0.07, bodyH * 0.58, bodyR * 0.98).sub(shoulder.position).add(new Vector3(0, 0, 0.02));
    const length = reach.length();
    const arm = kit.add(shoulder, new CapsuleGeometry(0.034, Math.max(0.02, length - 0.07), 4, 10), fur, THIN);
    arm.position.copy(reach).multiplyScalar(0.5);
    arm.quaternion.setFromUnitVectors(up, reach.clone().normalize());
    kit.add(shoulder, new SphereGeometry(0.042, 12, 10), skin, FINE).position.copy(reach);
  });
  if (spec.prop === "cheese") {
    const cheese = kit.add(hands, cheeseWedge(), kit.fur("#F5C542"), THIN);
    cheese.rotation.set(0.2, -0.4, 0.15);
    cheese.position.set(0, 0.03, 0.08);
    for (const [x, y] of [
      [0.03, 0.01],
      [-0.04, -0.015],
      [0.0, -0.03],
    ] as const) {
      kit.add(cheese, new SphereGeometry(0.013, 8, 6), kit.flat("#C99A1E"), { outline: false }).position.set(x, y, 0.058);
    }
  } else if (spec.prop === "crumb") {
    const crumb = kit.add(hands, new CylinderGeometry(0.06, 0.06, 0.03, 10), kit.fur("#C98B4A"), THIN);
    crumb.rotation.x = 1.2;
    crumb.position.set(0, 0.02, 0.06);
  } else if (spec.prop === "fork") {
    const fork = new Group();
    fork.position.set(0.09, 0.02, 0.04);
    fork.rotation.z = -0.15;
    hands.add(fork);
    const steel = kit.fur("#C7CDD6");
    kit.add(fork, new CylinderGeometry(0.008, 0.008, 0.42, 6), steel, FINE).position.y = 0.06;
    for (let i = -1; i <= 1; i++) kit.add(fork, new CylinderGeometry(0.005, 0.005, 0.09, 5), steel, FINE).position.set(i * 0.016, 0.3, 0);
    kit.add(fork, new BoxGeometry(0.05, 0.015, 0.01), steel, FINE).position.y = 0.26;
  }

  // --- A bandana round the neck ---
  if (spec.scarf) {
    const cloth = kit.fur(spec.scarf);
    const band = kit.add(torso, new TorusGeometry(bodyR * 0.62, 0.025, 8, 24), cloth, THIN);
    band.rotation.x = Math.PI / 2;
    band.position.y = bodyH * 0.88;
    const knot = kit.add(torso, new ConeGeometry(0.07, 0.12, 3), cloth, THIN);
    knot.rotation.set(Math.PI + 0.3, 0, 0);
    knot.position.set(0, bodyH * 0.8, bodyR * 0.6);
  }

  // --- Hats ---
  const hat = new Group();
  hat.position.set(0, 0.3, 0.02);
  head.add(hat);
  if (spec.hat === "party") {
    const cone = kit.add(hat, new ConeGeometry(0.075, 0.2, 20), kit.fur("#E8467C"), THIN);
    cone.position.y = 0.09;
    cone.rotation.z = 0.15;
    kit.add(hat, new SphereGeometry(0.025, 10, 8), kit.fur("#F5C542"), FINE).position.set(-0.015, 0.2, 0);
  } else if (spec.hat === "beanie") {
    const wool = kit.fur("#2E6FD8");
    kit.add(hat, new SphereGeometry(0.16, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), wool, THIN).position.y = -0.04;
    const rim = kit.add(hat, new TorusGeometry(0.155, 0.025, 8, 28), kit.fur("#F2EEE6"), THIN);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.035;
    kit.add(hat, new SphereGeometry(0.04, 12, 8), kit.fur("#F2EEE6"), FINE).position.y = 0.13;
  } else if (spec.hat === "crown") {
    const gold = kit.fur("#F2C14E");
    kit.add(hat, new CylinderGeometry(0.1, 0.1, 0.06, 20, 1, true), gold, THIN).position.y = 0.0;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = kit.add(hat, new ConeGeometry(0.025, 0.06, 6), gold, FINE);
      spike.position.set(Math.sin(a) * 0.095, 0.055, Math.cos(a) * 0.095);
    }
    kit.add(hat, new SphereGeometry(0.018, 8, 6), kit.fur("#C8102E"), FINE).position.set(0, 0.005, 0.1);
  } else if (spec.hat === "tophat") {
    const felt = kit.fur("#1E1B22");
    kit.add(hat, new CylinderGeometry(0.16, 0.16, 0.015, 24), felt, THIN).position.y = -0.01;
    kit.add(hat, new CylinderGeometry(0.095, 0.1, 0.18, 24), felt, THIN).position.y = 0.08;
    kit.add(hat, new CylinderGeometry(0.101, 0.101, 0.03, 24), kit.fur("#C8102E"), { outline: false }).position.y = 0.02;
  } else if (spec.hat === "chef") {
    kit.add(hat, new CylinderGeometry(0.1, 0.1, 0.08, 20), white, THIN).position.y = 0.01;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      kit.add(hat, new SphereGeometry(0.07, 14, 10), white, THIN).position.set(Math.sin(a) * 0.05, 0.1, Math.cos(a) * 0.05);
    }
    kit.add(hat, new SphereGeometry(0.08, 14, 10), white, THIN).position.y = 0.13;
  }

  const anim = spec.animation;
  const tipHome = tip.scale.clone();
  const sniffing = spec.pose === "sniff" ? 1.6 : 1;

  return {
    group,
    ready: Promise.resolve(),
    update(time) {
      const breathe = Math.sin(time * 2.2) * 0.02;
      bodyMesh.scale.set(bodyR * (1 + breathe), bodyH * (1 + breathe * 0.5), bodyR * 0.92 * (1 + breathe));
      // Sniff in short bursts: twitching nose, whiskers going.
      const burst = Math.max(0, Math.sin(time * 0.9)) ** 2 * sniffing;
      const twitch = Math.sin(time * anim.sniffSpeed) * burst;
      tip.scale.set(tipHome.x * (1 + twitch * 0.15), tipHome.y * (1 - twitch * 0.1), tipHome.z);
      snout.rotation.x = twitch * 0.03;
      whiskers.forEach((w, i) => (w.rotation.y = (i ? -1 : 1) * twitch * 0.12));
      ears.forEach((ear, i) => (ear.rotation.z = (i ? -1 : 1) * (0.35 + Math.sin(time * anim.earSpeed + i) * 0.06)));
      tailRoot.rotation.y = Math.sin(time * anim.tailSpeed) * anim.tailAmplitude;
      head.rotation.y = Math.sin(time * 0.5) * 0.12;
      head.rotation.z = Math.sin(time * 0.37) * 0.05;
      rig.position.y = Math.abs(Math.sin(time * 5)) * anim.bounce;
      if (waving) shoulders[1]!.rotation.z = Math.sin(time * 6) * 0.3;
    },
    dispose() {
      kit.dispose();
    },
  };
}
