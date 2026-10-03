import { CylinderGeometry, Group, Mesh, MeshLambertMaterial } from "three";
import { mulberry32 } from "@dno/generator";

const PIECES = 46;
const RADIUS = 0.3;
const HEIGHT = 0.22;

/**
 * A heap of kibble on the bench, beside an opened cat: croquettes wait for its holder in
 * the Pantry. It pours in when shown and glows on and off until it is taken away.
 * The group's origin is the middle of the heap's base; the caller puts it on the bench.
 */
export class KibblePile {
  readonly group = new Group();
  private readonly geometry = new CylinderGeometry(0.035, 0.035, 0.022, 8);
  private readonly material = new MeshLambertMaterial({ color: "#8A5A2B", emissive: "#F2B632", emissiveIntensity: 0 });
  private readonly rest: { mesh: Mesh; y: number; delay: number }[] = [];
  private time = 0;

  constructor(seed: number, private readonly reducedMotion = false) {
    const rand = mulberry32(seed ^ 0xc409);
    for (let i = 0; i < PIECES; i++) {
      // Denser and higher towards the middle: a cone of loose pieces.
      const r = RADIUS * Math.sqrt(rand());
      const a = rand() * Math.PI * 2;
      const y = 0.011 + (1 - r / RADIUS) * HEIGHT * (0.6 + rand() * 0.4);
      const mesh = new Mesh(this.geometry, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      mesh.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      this.group.add(mesh);
      this.rest.push({ mesh, y, delay: (y / HEIGHT) * 0.6 + rand() * 0.25 });
    }
    this.group.visible = false;
  }

  /** Pours the heap onto the bench, or takes it away. */
  set(shown: boolean): void {
    if (shown === this.group.visible) return;
    this.group.visible = shown;
    this.time = this.reducedMotion ? 10 : 0;
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.time += Math.min(dt, 0.1);
    // Each piece drops onto the heap, the bottom ones first.
    for (const p of this.rest) {
      const t = Math.max(0, Math.min(1, (this.time - p.delay) / 0.35));
      p.mesh.visible = t > 0;
      p.mesh.position.y = p.y + (1 - t * t) * 1.2;
    }
    // Then it glows, so the holder sees there is something to collect.
    this.material.emissiveIntensity = this.reducedMotion ? 0.25 : 0.45 * (0.5 + 0.5 * Math.sin(this.time * 5));
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
