import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  RingGeometry,
  SpotLight,
  Vector3,
} from "three";
import type { CatSpec } from "@dno/generator";
import { createCat, outlineMaterial, toon, type CatObject } from "@dno/scene";
import { damp, PALETTE, Stage } from "./stage";

/** How far the cats stand from the middle of the turntable. Grows with the crowd. */
const radiusFor = (n: number) => Math.max(1.5, n * 0.3);
const CONFETTI = 140;
const CONFETTI_COLORS = [PALETTE.red, PALETTE.sodium, PALETTE.spectral, PALETTE.tape, "#E85D9C", "#4FA3E0"];
const TAU = Math.PI * 2;

interface Seat {
  holder: Group;
  cat: CatObject;
  angle: number;
  /** 0 → 1 as the cat pops onto its pedestal. */
  pop: number;
  delay: number;
  hop: number;
  size: number;
}

/**
 * A turntable of cats on little pedestals. The one in front is the one being looked at:
 * it is bigger, it gets the spotlight and a shower of confetti when it arrives. Click a
 * cat to spin it round to the front.
 */
export class ParadeScene {
  onSelect: ((index: number) => void) | null = null;

  private readonly stage: Stage;
  private readonly table = new Group();
  private readonly ring: Mesh;
  private readonly lamp: SpotLight;
  private readonly confetti: Points;
  private readonly velocities = new Float32Array(CONFETTI * 3);
  private seats: Seat[] = [];
  private selected = 0;
  private spin = 0;
  private spinTarget = 0;
  private confettiAge = Infinity;
  private radius = 2;

  constructor(host: HTMLElement) {
    const stage = (this.stage = new Stage(host));
    stage.scene.add(this.table);

    this.ring = new Mesh(new RingGeometry(0.62, 0.72, 48), new MeshBasicMaterial({ color: PALETTE.sodium, transparent: true, opacity: 0.85, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.012;
    stage.scene.add(this.ring);

    this.lamp = new SpotLight("#FFE2B0", 26, 10, 0.42, 0.6, 1.4);
    stage.scene.add(this.lamp, this.lamp.target);

    const geo = new BufferGeometry();
    const colors = new Float32Array(CONFETTI * 3);
    const c = new Color();
    for (let i = 0; i < CONFETTI; i++) c.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]!).toArray(colors, i * 3);
    geo.setAttribute("position", new BufferAttribute(new Float32Array(CONFETTI * 3), 3));
    geo.setAttribute("color", new BufferAttribute(colors, 3));
    this.confetti = new Points(geo, new PointsMaterial({ size: 0.11, vertexColors: true, transparent: true, depthWrite: false }));
    this.confetti.frustumCulled = false;
    this.confetti.visible = false;
    stage.scene.add(this.confetti);

    stage.onSelect = (id) => this.onSelect?.(Number(id));
    stage.onLayout = (aspect) => this.frame(aspect);
    stage.onFrame((time, dt) => this.update(time, dt));
  }

  /** Puts a new line-up on the turntable. The cats pop up one after the other. */
  setCats(cats: readonly CatSpec[], selected = 0): void {
    for (const s of this.seats) {
      s.holder.removeFromParent();
      s.cat.dispose();
    }
    this.stage.pickables.length = 0;
    this.radius = radiusFor(cats.length);
    this.seats = cats.map((spec, i) => {
      const angle = (i / cats.length) * TAU;
      const holder = new Group();
      holder.userData.pick = String(i);
      const pedestalGeo = new CylinderGeometry(0.5, 0.56, 0.2, 32);
      const pedestal = new Mesh(pedestalGeo, toon(i % 2 ? PALETTE.kraft : PALETTE.tape));
      pedestal.add(new Mesh(pedestalGeo, outlineMaterial(PALETTE.ink, 0.02)));
      pedestal.position.y = 0.1;
      const cat = createCat(spec);
      cat.group.position.y = 0.2;
      holder.add(pedestal, cat.group);
      holder.scale.setScalar(0.001);
      this.table.add(holder);
      this.stage.pickables.push(holder);
      return { holder, cat, angle, pop: 0, delay: this.stage.reduced ? 0 : i * 0.07, hop: 0, size: 1 };
    });
    this.selected = -1;
    this.select(selected);
    this.frame(this.stage.camera.aspect);
  }

  /** Spins the turntable so cat `index` faces the front, and throws confetti at it. */
  select(index: number): void {
    if (index === this.selected || !this.seats[index]) return;
    this.selected = index;
    const target = -this.seats[index]!.angle;
    // The short way round.
    let delta = (target - this.spinTarget) % TAU;
    if (delta > Math.PI) delta -= TAU;
    if (delta < -Math.PI) delta += TAU;
    this.spinTarget += delta;
    if (this.stage.reduced) this.spin = this.spinTarget;
    this.seats[index]!.hop = 1;
    this.burst();
    this.stage.wake();
  }

  dispose(): void {
    for (const s of this.seats) s.cat.dispose();
    this.stage.dispose();
  }

  private frame(aspect: number): void {
    const r = this.radius;
    // A narrow screen sees the front cat and a little of its neighbours; a wide one the whole ring.
    const width = aspect < 1.3 ? 3.4 : 2 * r + 1.6;
    this.stage.frame(new Vector3(0, 0.8, r * 0.55), width, 3.4, new Vector3(0, 0.42, 1));
    this.lamp.position.set(0.6, 4.6, r + 1.8);
    this.lamp.target.position.set(0, 0.6, r);
    this.ring.position.z = r;
  }

  private burst(): void {
    if (this.stage.reduced) return;
    const pos = this.confetti.geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < CONFETTI; i++) {
      pos.setXYZ(i, (Math.random() - 0.5) * 0.4, 1.4 + Math.random() * 0.3, this.radius + (Math.random() - 0.5) * 0.4);
      const a = Math.random() * TAU;
      const out = 0.6 + Math.random() * 1.8;
      this.velocities.set([Math.cos(a) * out, 2 + Math.random() * 2.6, Math.sin(a) * out * 0.6], i * 3);
    }
    pos.needsUpdate = true;
    this.confettiAge = 0;
    this.confetti.visible = true;
  }

  private update(time: number, dt: number): void {
    this.spin = damp(this.spin, this.spinTarget, 5, dt);
    this.table.rotation.y = this.spin;

    for (const [i, s] of this.seats.entries()) {
      s.holder.position.set(Math.sin(s.angle) * this.radius, 0, Math.cos(s.angle) * this.radius);
      s.holder.rotation.y = s.angle;
      if (s.delay > 0) s.delay -= dt;
      else s.pop = Math.min(1, s.pop + dt * 2.2);
      const front = i === this.selected;
      s.size = damp(s.size, front ? 1.25 : 0.8, 6, dt);
      s.hop = Math.max(0, s.hop - dt * 1.6);
      // A jump with a squash on landing, like a cartoon.
      const up = Math.sin(s.hop * Math.PI) * 0.45 * (s.hop > 0 ? 1 : 0);
      const squash = s.hop > 0 && s.hop < 0.18 ? 1 - Math.sin((s.hop / 0.18) * Math.PI) * 0.18 : 1;
      s.holder.scale.set(s.size * elastic(s.pop) * (2 - squash), s.size * elastic(s.pop) * squash, s.size * elastic(s.pop) * (2 - squash));
      s.cat.group.position.y = 0.2 + up;
      s.cat.update(time);
    }

    this.ring.rotation.z = time * 0.6;
    const ringMat = this.ring.material as MeshBasicMaterial;
    ringMat.opacity = 0.55 + Math.sin(time * 3) * 0.25;

    if (this.confettiAge < 2.2) {
      this.confettiAge += dt;
      const pos = this.confetti.geometry.getAttribute("position") as BufferAttribute;
      for (let i = 0; i < CONFETTI; i++) {
        const v = this.velocities;
        v[i * 3 + 1]! -= 5.5 * dt;
        // Air drag: confetti flutters rather than falls.
        v[i * 3]! *= 1 - dt * 1.2;
        v[i * 3 + 2]! *= 1 - dt * 1.2;
        pos.setXYZ(i, pos.getX(i) + v[i * 3]! * dt, Math.max(0.02, pos.getY(i) + v[i * 3 + 1]! * dt), pos.getZ(i) + v[i * 3 + 2]! * dt);
      }
      pos.needsUpdate = true;
      (this.confetti.material as PointsMaterial).opacity = Math.min(1, (2.2 - this.confettiAge) * 1.5);
    } else {
      this.confetti.visible = false;
    }
  }
}

/** 0 → 1 with a springy overshoot. */
function elastic(x: number): number {
  if (x <= 0) return 0.001;
  if (x >= 1) return 1;
  return 1 + 2 ** (-10 * x) * Math.sin(((x * 10 - 0.75) * TAU) / 3);
}
