import { BufferGeometry, CapsuleGeometry, CylinderGeometry, Group, type Material, Mesh, SphereGeometry } from "three";
import { BOX_SIZE, type BoxObject } from "../box/buildBox";
import { outlineMaterial, toon } from "../materials";

const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * pet(): a hand comes down over the box, the back flap lifts, and the hand reaches into
 * the dark to stroke whatever is in there a few times. The box leans into it and purrs,
 * then the hand slips out and the flap drops back. Nothing of the cat is ever shown.
 */
export class PetEffect {
  /** One stroke, at the bottom of its push. */
  onStroke: (() => void) | null = null;
  /** The cat has had its fill: the strokes are over. */
  onPetted: (() => void) | null = null;

  private readonly hand = new Group();
  private readonly wrist = new Group();
  private readonly fingers: Group[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private time = -1;
  private strokesDone = 0;
  private petted = false;

  // Timeline, in seconds.
  private readonly strokes: number;
  private readonly strokeTime = 0.62;
  private readonly approach = 0.7;
  private readonly dive = 0.4;

  constructor(private readonly box: BoxObject, private readonly reducedMotion = false) {
    this.strokes = reducedMotion ? 1 : 3;
    this.build();
    this.hand.visible = false;
    this.hand.scale.setScalar(1.6);
    box.body.add(this.hand);
  }

  get active(): boolean {
    return this.time >= 0;
  }

  pet(): void {
    if (this.active) return;
    this.time = 0;
    this.strokesDone = 0;
    this.petted = false;
    this.hand.visible = true;
    this.update(0);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.time += Math.min(dt, 0.05);
    const t = this.time;
    const { flaps, body } = this.box;
    const H = BOX_SIZE.height;

    const inAt = this.approach + this.dive;
    const outAt = inAt + this.strokes * this.strokeTime;
    const goneAt = outAt + 0.6;

    // The back flap swings up as the hand arrives and drops once it is out.
    const open = smooth((t - 0.25) / 0.4) * (1 - smooth((t - outAt - 0.35) / 0.3));
    flaps.major[1].rotation.x = -open * 1.25;

    // Where the palm is, and how much the fingers curl.
    const above = { x: 0.25, y: H + 1.25, z: -0.05 };
    const gap = { x: 0, y: H + 0.12, z: -0.24 };
    const deep = { x: 0, y: H - 0.24, z: -0.24 };
    let x: number, y: number, z: number;
    let curl = 0.15;
    let tilt = 0;
    if (t < this.approach) {
      const k = smooth(t / this.approach);
      x = lerp(above.x, gap.x, k);
      y = lerp(above.y, gap.y, k);
      z = lerp(above.z, gap.z, k);
      tilt = (1 - k) * 0.35;
    } else if (t < inAt) {
      const k = smooth((t - this.approach) / this.dive);
      x = gap.x;
      y = lerp(gap.y, deep.y, k);
      z = gap.z;
      curl = lerp(0.15, 0.35, k);
    } else if (t < outAt) {
      // Long strokes from the back of the box towards the front, pressing in mid-way.
      const s = (t - inAt) / this.strokeTime;
      const n = Math.floor(s);
      const f = s - n;
      const push = f < 0.65 ? smooth(f / 0.65) : 1 - smooth((f - 0.65) / 0.35);
      x = Math.sin(n * 2.1) * 0.03;
      z = lerp(-0.36, -0.1, push);
      y = deep.y - Math.sin(Math.min(1, f / 0.65) * Math.PI) * 0.05 * (f < 0.65 ? 1 : 0);
      curl = 0.35 + Math.sin(Math.min(1, f / 0.65) * Math.PI) * 0.25;
      if (f >= 0.65 && this.strokesDone <= n) {
        this.strokesDone = n + 1;
        this.onStroke?.();
      }
      if (!this.petted && t > inAt + 0.15) {
        this.petted = true;
        this.onPetted?.();
      }
    } else {
      const k = smooth((t - outAt) / (goneAt - outAt));
      x = lerp(deep.x, above.x, k);
      y = lerp(deep.y, above.y, k * k);
      z = lerp(-0.2, above.z, k);
      curl = lerp(0.35, 0.1, k);
      tilt = k * 0.3;
    }

    this.hand.position.set(x, y, z);
    this.hand.rotation.set(tilt, 0, 0);
    this.fingers.forEach((finger, i) => (finger.rotation.x = -curl * (1 + i * 0.06)));

    // The box leans into the hand and purrs while it is being stroked.
    if (t >= inAt && t < outAt + 0.3 && !this.reducedMotion) {
      const purr = Math.sin(t * 46) * 0.004;
      const lean = Math.sin(((t - inAt) / this.strokeTime) * Math.PI * 2) * 0.012;
      body.rotation.x = lean;
      body.scale.set(1 + purr, 1 - purr, 1 + purr);
    } else {
      body.rotation.x = 0;
      body.scale.set(1, 1, 1);
    }

    if (t >= goneAt + 0.1) this.finish();
  }

  private finish() {
    this.time = -1;
    this.hand.visible = false;
    this.box.body.rotation.x = 0;
    this.box.body.scale.set(1, 1, 1);
    this.box.flaps.major[1].rotation.x = 0;
  }

  /** A cartoon right hand, palm down, fingers towards the back of the box, and a sleeve up to the sky. */
  private build() {
    const skin = toon("#F1C29A");
    const sleeve = toon("#4A6A96");
    const cuff = toon("#E9E2D2");
    const line = outlineMaterial("#1A1410", 0.008);
    this.materials.push(skin, sleeve, cuff, line);

    const add = (geo: BufferGeometry, mat: Material, parent: Group) => {
      this.geometries.push(geo);
      const mesh = new Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.add(new Mesh(geo, line));
      parent.add(mesh);
      return mesh;
    };

    // Palm: a flattened ball, narrow enough to slip between the minor flaps.
    const palm = new SphereGeometry(1, 18, 12);
    palm.scale(0.075, 0.03, 0.085);
    add(palm, skin, this.hand);

    // Four fingers hinged at the knuckles, the middle ones a touch longer.
    const lengths = [0.07, 0.085, 0.08, 0.065];
    lengths.forEach((len, i) => {
      const knuckle = new Group();
      knuckle.position.set(-0.05 + i * 0.033, 0, -0.07);
      this.hand.add(knuckle);
      const geo = new CapsuleGeometry(0.016, len, 4, 8);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, 0, -len / 2 - 0.012);
      add(geo, skin, knuckle);
      this.fingers.push(knuckle);
    });

    // Thumb on the left, tucked forward.
    const thumb = new CapsuleGeometry(0.018, 0.05, 4, 8);
    thumb.rotateX(Math.PI / 2);
    thumb.translate(0, 0, -0.035);
    const thumbMesh = add(thumb, skin, this.hand);
    thumbMesh.position.set(-0.075, -0.004, 0.0);
    thumbMesh.rotation.y = 0.7;

    // Wrist, cuff and sleeve, rising up and towards the viewer.
    this.wrist.position.set(0, 0.005, 0.07);
    this.wrist.rotation.x = 0.4;
    this.hand.add(this.wrist);
    const wristGeo = new CylinderGeometry(0.045, 0.05, 0.12, 12);
    wristGeo.translate(0, 0.06, 0);
    add(wristGeo, skin, this.wrist);
    const cuffGeo = new CylinderGeometry(0.062, 0.062, 0.05, 14);
    cuffGeo.translate(0, 0.13, 0);
    add(cuffGeo, cuff, this.wrist);
    const sleeveGeo = new CylinderGeometry(0.068, 0.078, 1.6, 14);
    sleeveGeo.translate(0, 0.95, 0);
    add(sleeveGeo, sleeve, this.wrist);
  }

  dispose(): void {
    this.finish();
    this.box.body.remove(this.hand);
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
