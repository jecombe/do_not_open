import { CylinderGeometry, Group, Mesh, MeshLambertMaterial } from "three";
import { mulberry32 } from "@dno/generator";
import { BOX_SIZE, type BoxObject } from "../box/buildBox";

interface Kibble {
  mesh: Mesh;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  /** True for pieces aimed at the gap under the lifted flap. */
  lands: boolean;
  state: "falling" | "rolling" | "gone";
  age: number;
}

/**
 * feed(): a handful of kibble drops onto the box. The front flap lifts just enough to
 * let most of it in; a piece or two misses and rattles off the lid. Then the box gives
 * one satisfied hop.
 */
export class FeedEffect {
  /** A piece hit the cardboard. */
  onTick: (() => void) | null = null;
  /** Everything that was going in is in. */
  onEaten: (() => void) | null = null;

  private readonly group = new Group();
  private readonly geometry = new CylinderGeometry(0.035, 0.035, 0.022, 8);
  private readonly material = new MeshLambertMaterial({ color: "#8A5A2B" });
  private pieces: Kibble[] = [];
  private time = -1;
  private eaten = false;
  private readonly rand: () => number;

  constructor(private readonly box: BoxObject, private readonly reducedMotion = false) {
    this.rand = mulberry32(box.spec.noiseSeed ^ 0xfeed);
    box.group.add(this.group);
  }

  get active(): boolean {
    return this.time >= 0;
  }

  drop(): void {
    if (this.active) return;
    this.time = 0;
    this.eaten = false;
    const count = this.reducedMotion ? 3 : 7;
    for (let i = 0; i < count; i++) {
      const lands = i < count - 2;
      const mesh = new Mesh(this.geometry, this.material);
      mesh.castShadow = true;
      // Aim: the slot along the front edge of the lid, or the middle of the lid for misses.
      const targetZ = lands ? BOX_SIZE.depth * 0.28 + this.rand() * 0.1 : -0.1 + this.rand() * 0.2;
      mesh.position.set((this.rand() - 0.5) * 0.7, BOX_SIZE.height + 1.3 + i * 0.16, targetZ);
      mesh.rotation.set(this.rand() * 3, this.rand() * 3, this.rand() * 3);
      this.group.add(mesh);
      this.pieces.push({ mesh, vx: (this.rand() - 0.5) * 0.3, vy: 0, vz: 0, spin: 4 + this.rand() * 8, lands, state: "falling", age: 0 });
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    const step = Math.min(dt, 0.05);
    this.time += step;
    const { flaps, body } = this.box;
    const lidY = BOX_SIZE.height + BOX_SIZE.wall + 0.012;

    // The flap opens a crack while food is incoming, then shuts.
    const gap = Math.min(1, this.time / 0.25) * (1 - Math.min(1, Math.max(0, (this.time - 1.25) / 0.2)));
    flaps.major[0].rotation.x = gap * 0.55;

    let pending = 0;
    for (const k of this.pieces) {
      if (k.state === "gone") continue;
      pending++;
      k.age += step;
      const p = k.mesh.position;
      k.vy -= 9.8 * step;
      p.x += k.vx * step;
      p.y += k.vy * step;
      p.z += k.vz * step;
      k.mesh.rotation.x += k.spin * step;
      k.mesh.rotation.z += k.spin * 0.7 * step;

      if (k.state === "falling" && p.y <= lidY && k.vy < 0) {
        if (k.lands) {
          // Through the gap and into the dark.
          if (p.y < BOX_SIZE.height - 0.15) this.remove(k);
        } else {
          p.y = lidY;
          k.vy = -k.vy * 0.38;
          k.vz = (this.rand() < 0.5 ? -1 : 1) * (0.5 + this.rand() * 0.5);
          k.vx += (this.rand() - 0.5) * 0.8;
          this.onTick?.();
          if (k.vy < 0.5) k.state = "rolling";
        }
      } else if (k.state === "rolling" && (p.y < -BOX_SIZE.height || k.age > 2.4)) {
        this.remove(k);
      }
      // Pieces that bounced off the lid fall past it once clear of the edges.
      if (k.state === "rolling" && Math.abs(p.z) < BOX_SIZE.depth / 2 && Math.abs(p.x) < BOX_SIZE.width / 2 && p.y < lidY) {
        p.y = lidY;
        k.vy = 0;
      }
    }

    // Once the food is in: one squashy hop.
    const landed = this.pieces.every((k) => !k.lands || k.state === "gone");
    if (landed && !this.eaten && this.time > 0.6) {
      this.eaten = true;
      this.hopStart = this.time;
      this.onEaten?.();
    }
    if (this.eaten) {
      const h = Math.min(1, (this.time - this.hopStart) / 0.5);
      const arc = Math.sin(h * Math.PI);
      body.position.y = arc * (this.reducedMotion ? 0.02 : 0.11);
      body.scale.set(1 + arc * 0.04, 1 - arc * 0.06, 1 + arc * 0.04);
      if (h >= 1 && pending === 0) this.finish();
      else if (h >= 1 && this.time > 3.2) this.finish();
    }
  }

  private hopStart = 0;

  private remove(k: Kibble) {
    k.state = "gone";
    this.group.remove(k.mesh);
  }

  private finish() {
    for (const k of this.pieces) this.group.remove(k.mesh);
    this.pieces = [];
    this.time = -1;
    this.box.body.position.y = 0;
    this.box.body.scale.set(1, 1, 1);
    this.box.flaps.major[0].rotation.x = 0;
  }

  dispose(): void {
    this.finish();
    this.box.group.remove(this.group);
    this.geometry.dispose();
    this.material.dispose();
  }
}
