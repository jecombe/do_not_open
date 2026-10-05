import { BufferAttribute, BufferGeometry, Euler, Matrix4, Vector3 } from "three";

/**
 * Bends a straight tail model along a chain of joints, on the CPU. A few hundred
 * vertices per animal, and the outline and the ghost shader follow for free because they
 * share the geometry. The model lies along +Y from its root, `segments` segments of
 * `modelSegment` each; `segLen` stretches it to the length wanted.
 */
export class BentTail {
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

  constructor(
    src: BufferGeometry,
    fluff: number,
    private readonly segLen: number,
    private readonly segments: number,
    modelSegment: number,
  ) {
    const stretch = segLen / modelSegment;
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
    for (let i = 0; i < segments; i++) this.joints.push(new Matrix4());
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
    const last = this.segments - 1;
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
