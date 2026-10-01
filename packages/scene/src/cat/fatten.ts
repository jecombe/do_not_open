import { Box3, BufferAttribute, BufferGeometry, Vector3 } from "three";

/**
 * Reshapes a weighed cat's body. Scaling the whole body sideways makes a wide cat, not a fat
 * one: the fat goes to the belly. This bends the body mesh on the CPU, once, so the belly
 * swells low and forward and starts to hang, the back stays narrower, and the heaviest cats
 * get rolls. `excess` is girth − 1: about −0.15 for a thin cat, 0.75 for a huge one.
 *
 * The same mapping moves the anchors (head, neck, tail) so what sits on the body follows it.
 */
export class BodyShape {
  readonly bounds = new Box3();
  private readonly min: Vector3;
  private readonly height: number;
  private readonly centreZ: number;

  constructor(
    rest: Box3,
    private readonly excess: number,
    /** Sitting cats grow front to back as well; lying ones mostly sideways and up. */
    private readonly deep: boolean,
  ) {
    this.min = rest.min.clone();
    this.height = Math.max(1e-6, rest.max.y - rest.min.y);
    this.centreZ = (rest.min.z + rest.max.z) / 2;
  }

  /** Sideways, front and back stretch at height `h` (0 floor, 1 top). */
  private factors(h: number): { x: number; front: number; back: number; y: number } {
    // A thin cat is drawn thinner than its girth says: hollow flanks read better than a slim scale.
    const d = this.excess < 0 ? this.excess * 1.8 : this.excess;
    const belly = bell(h, this.deep ? 0.33 : 0.4, this.deep ? 0.3 : 0.38);
    // Rolls: two soft ripples across the belly of the heaviest cats.
    const rolls = d > 0.5 ? 1 + (d - 0.5) * 0.16 * Math.max(0, Math.sin(h * Math.PI * 7)) * belly : 1;
    return {
      x: (1 + d * (0.55 + 1.0 * belly)) * rolls,
      front: (1 + d * (this.deep ? 0.35 + 1.25 * belly : 0.15 + 0.5 * belly)) * rolls,
      back: 1 + d * (this.deep ? 0.45 : 0.1),
      // A lying cat gets rounder on top; a sitting one settles a little.
      y: this.deep ? 1 - d * 0.04 : 1 + d * 0.22 * belly,
    };
  }

  /** Where a point of the rest body ends up. */
  apply(p: Vector3, out = new Vector3()): Vector3 {
    const h = Math.min(1, Math.max(0, (p.y - this.min.y) / this.height));
    const f = this.factors(h);
    const dz = p.z - this.centreZ;
    return out.set(p.x * f.x, this.min.y + (p.y - this.min.y) * f.y, this.centreZ + dz * (dz > 0 ? f.front : f.back));
  }

  /** A reshaped copy of `src`. Normals follow the local stretch, which is close enough for toon shading. */
  reshape(src: BufferGeometry): BufferGeometry {
    const geo = src.clone();
    const pos = geo.getAttribute("position") as BufferAttribute;
    const nor = geo.getAttribute("normal") as BufferAttribute | undefined;
    const p = new Vector3();
    const n = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      const h = Math.min(1, Math.max(0, (p.y - this.min.y) / this.height));
      const f = this.factors(h);
      const fz = p.z - this.centreZ > 0 ? f.front : f.back;
      if (nor) {
        n.fromBufferAttribute(nor, i);
        n.set(n.x / f.x, n.y / f.y, n.z / fz).normalize();
        nor.setXYZ(i, n.x, n.y, n.z);
      }
      this.apply(p, p);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    if (nor) nor.needsUpdate = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    this.bounds.copy(geo.boundingBox!);
    return geo;
  }
}

function bell(h: number, centre: number, width: number): number {
  const t = (h - centre) / width;
  return Math.exp(-t * t);
}
