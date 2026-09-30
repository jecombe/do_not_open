import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Texture,
} from "three";
import type { BoxSpec } from "@dno/generator";
import { outlineMaterial, toon } from "../materials";
import { arrowsTexture, cardboardTexture, labelTexture, stampTexture, type TextureOptions } from "./textures";

export const BOX_SIZE = { width: 1.2, height: 0.9, depth: 1.0, wall: 0.02 } as const;

export interface BoxObject {
  /** Outer group. Origin at the centre of the bottom face. */
  group: Group;
  /** Everything that rocks when shaken. Pivot is the bottom centre. */
  body: Group;
  /** Lid flaps, hinged on their outer edge: two major (front, back), two minor (left, right). */
  flaps: { major: [Group, Group]; minor: [Group, Group] };
  /** Tape strips and the lid stamp printed across them, kept apart so the opening sequence can rip them off. */
  tape: Group;
  /** Dark plane just under the lid. The opening sequence drops it to the bottom. */
  interior: Mesh;
  spec: BoxSpec;
  dispose(): void;
}

/** A sealed cardboard box: walls, four hinged flaps, tape, shipping label and the stamp. */
export function createBox(spec: BoxSpec, opts: TextureOptions = {}): BoxObject {
  const { width: W, height: H, depth: D, wall: T } = BOX_SIZE;
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];

  const cardTex = cardboardTexture(spec.noiseSeed, spec.wear, opts);
  textures.push(cardTex);
  const card = toon("#FFFFFF", { map: cardTex });
  const inner = toon("#8E6640");
  const outline = outlineMaterial("#1A1410", 0.008);
  materials.push(card, inner, outline);

  const group = new Group();
  group.name = `box:${spec.serial}`;
  const body = new Group();
  group.add(body);

  const panel = (w: number, h: number, d: number, parent: Group, x: number, y: number, z: number, withOutline = true) => {
    const geo = new BoxGeometry(w, h, d);
    geometries.push(geo);
    const mesh = new Mesh(geo, card);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (withOutline) mesh.add(new Mesh(geo, outline));
    parent.add(mesh);
    return mesh;
  };

  panel(W, T, D, body, 0, T / 2, 0);
  panel(W, H, T, body, 0, H / 2, D / 2 - T / 2);
  panel(W, H, T, body, 0, H / 2, -D / 2 + T / 2);
  panel(T, H, D - 2 * T, body, W / 2 - T / 2, H / 2, 0);
  panel(T, H, D - 2 * T, body, -W / 2 + T / 2, H / 2, 0);

  // Flaps pivot on the top edge they are attached to. Rotation 0 = closed.
  const hinge = (x: number, y: number, z: number) => {
    const g = new Group();
    g.position.set(x, y, z);
    body.add(g);
    return g;
  };
  const minorL = hinge(-W / 2, H - T, 0);
  const minorR = hinge(W / 2, H - T, 0);
  panel(D / 2, T, D - 2 * T, minorL, D / 4, T / 2, 0, false);
  panel(D / 2, T, D - 2 * T, minorR, -D / 4, T / 2, 0, false);
  const majorF = hinge(0, H, D / 2);
  const majorB = hinge(0, H, -D / 2);
  panel(W, T, D / 2 - 0.004, majorF, 0, T / 2, -D / 4);
  panel(W, T, D / 2 - 0.004, majorB, 0, T / 2, D / 4);

  // --- Tape along the lid seam and down both ends ---
  const tape = new Group();
  body.add(tape);
  const tapeMat = toon("#D9C28A", { transparent: true, opacity: 0.93 });
  materials.push(tapeMat);
  const tapeW = 0.13;
  const tz = spec.tapeOffset * D * 0.5;
  const strip = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const geo = new BoxGeometry(w, h, d);
    geometries.push(geo);
    const m = new Mesh(geo, tapeMat);
    m.position.set(x, y, z);
    tape.add(m);
  };
  strip(W + 0.012, 0.004, tapeW, 0, H + T + 0.002, tz);
  strip(0.004, 0.24, tapeW, W / 2 + 0.004, H + T - 0.118, tz);
  strip(0.004, 0.24, tapeW, -W / 2 - 0.004, H + T - 0.118, tz);

  const decal = (tex: Texture, w: number, h: number, parent: Group) => {
    textures.push(tex);
    const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    materials.push(mat);
    const geo = new PlaneGeometry(w, h);
    geometries.push(geo);
    const mesh = new Mesh(geo, mat);
    parent.add(mesh);
    return mesh;
  };

  // --- Shipping label on the front ---
  const label = decal(labelTexture(spec, opts), 0.54, 0.36, body);
  label.position.set(-0.2, 0.47, D / 2 + 0.002);
  label.rotation.z = spec.labelSkew;
  (label.material as MeshBasicMaterial).color.set("#D8CFBE");

  // --- The stamp: once across the lid (over the tape), once on the front ---
  const stampTex = stampTexture(spec.noiseSeed, spec.wear, opts);
  const lidStamp = decal(stampTex, 0.96, 0.36, tape);
  lidStamp.rotation.x = -Math.PI / 2;
  lidStamp.rotation.z = spec.stampRotation;
  lidStamp.position.set(spec.stampOffset[0], H + T + 0.006, 0.02 + spec.stampOffset[1]);
  const frontStamp = decal(stampTex, 0.4, 0.15, body);
  frontStamp.position.set(0.34, 0.3, D / 2 + 0.003);
  frontStamp.rotation.z = spec.stampRotation * 1.4 + 0.1;

  // --- "This side up" on both ends ---
  const arrows = arrowsTexture(opts);
  for (const side of [-1, 1]) {
    const a = decal(arrows, 0.3, 0.3, body);
    a.position.set(side * (W / 2 + 0.002), 0.32, -0.22 * side);
    a.rotation.y = (side * Math.PI) / 2;
  }

  // --- Dents: soft dark smudges on the side walls ---
  const dentMat = new MeshBasicMaterial({ color: "#3A2414", transparent: true, opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  materials.push(dentMat);
  for (const dent of spec.dents) {
    const geo = new CircleGeometry(dent.radius, 14);
    geometries.push(geo);
    const m = new Mesh(geo, dentMat);
    const faceW = dent.face % 2 === 0 ? W : D;
    const u = (dent.u - 0.5) * faceW * 0.9;
    const y = dent.v * H;
    const out = (dent.face % 2 === 0 ? D : W) / 2 + 0.0015;
    m.rotation.y = (dent.face * Math.PI) / 2;
    if (dent.face === 0) m.position.set(u, y, out);
    else if (dent.face === 1) m.position.set(out, y, -u);
    else if (dent.face === 2) m.position.set(-u, y, -out);
    else m.position.set(-out, y, u);
    m.scale.y = 0.6;
    body.add(m);
  }

  // Dark interior plane under the lid, visible when the flaps lift.
  const dark = new Mesh(new PlaneGeometry(W - 2 * T, D - 2 * T), inner);
  geometries.push(dark.geometry);
  dark.rotation.x = -Math.PI / 2;
  dark.position.y = H - T * 1.6;
  body.add(dark);

  return {
    group,
    body,
    flaps: { major: [majorF, majorB], minor: [minorL, minorR] },
    tape,
    interior: dark,
    spec,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}
