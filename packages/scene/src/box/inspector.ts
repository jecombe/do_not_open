import { CylinderGeometry, Group, Mesh, MeshBasicMaterial, Object3D, PointLight, RingGeometry, Vector3 } from "three";
import { toon } from "../materials";
import type { BoxObject } from "./buildBox";

export interface InspectOptions {
  /** Colour of the lamp that comes on over the mat. */
  light?: string;
  reducedMotion?: boolean;
}

/** Where the cat sits once it is out, and how far the box slides to make room. Bench space. */
const OUT = new Vector3(0.72, 0, 0.1);
const BOX_SLIDE = -0.72;
const HOP = 0.8;
const DURATION = 1.1;

const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

/**
 * Lifts the contents of an opened box out onto the bench, on an inspection mat under its
 * own lamp, and puts them back. The box slides aside to make room.
 *
 * `content` must already be resting inside the box (the opening sequence is over). The
 * box must sit in its parent at the position it should come back to.
 */
export class CatInspector {
  /** Fires when the contents touch down, on the mat or back in the box. */
  onLand: (() => void) | null = null;

  /** Mat and lamp. Lives next to the box, in the same parent. */
  readonly group = new Group();

  private progress = 0;
  private target = 0;
  private readonly duration: number;
  private readonly parent: Object3D;
  private readonly boxHome: number;
  private readonly inBox = { position: new Vector3(), scale: 1, rotX: 0 };
  private readonly mat: Group;
  private readonly lamp: PointLight;

  constructor(
    private readonly box: BoxObject,
    private readonly content: Object3D,
    opts: InspectOptions = {},
  ) {
    const parent = box.group.parent;
    if (!parent) throw new Error("CatInspector: put the box in the scene first");
    this.parent = parent;
    this.duration = opts.reducedMotion ? 0.001 : DURATION;
    this.boxHome = box.group.position.x;

    // An inspection mat: a paper disc with a stamped ring, like a target for small parcels.
    this.mat = new Group();
    const disc = new Mesh(new CylinderGeometry(0.62, 0.62, 0.012, 40), toon("#A89C84"));
    disc.position.y = 0.006;
    disc.receiveShadow = true;
    const ring = new Mesh(new RingGeometry(0.53, 0.56, 48), new MeshBasicMaterial({ color: "#8E2019" }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.0135;
    this.mat.add(disc, ring);
    this.mat.position.copy(OUT).setX(OUT.x + this.boxHome);
    this.mat.visible = false;

    this.lamp = new PointLight(opts.light ?? "#FFF1DC", 0, 5, 1.4);
    this.lamp.position.set(OUT.x + this.boxHome + 0.6, 1.7, OUT.z + 1.6);

    this.group.add(this.mat, this.lamp);
    parent.add(this.group);
  }

  /** True once the contents are out, or on their way out. */
  get out(): boolean {
    return this.target === 1;
  }

  get moving(): boolean {
    return this.progress !== this.target;
  }

  /** Bench-space point to aim a camera at while inspecting. */
  focus(into = new Vector3()): Vector3 {
    return into.set(OUT.x + this.boxHome, 0.56, OUT.z);
  }

  takeOut(): void {
    if (this.target === 1) return;
    if (this.progress === 0) {
      // Remember the resting pose, then move the contents from the box to the bench
      // without moving them on screen.
      this.parent.attach(this.content);
      this.inBox.position.copy(this.content.position);
      this.inBox.scale = this.content.scale.x;
      this.inBox.rotX = this.content.rotation.x;
    }
    this.target = 1;
  }

  putBack(): void {
    this.target = 0;
  }

  update(dt: number): void {
    if (this.progress === this.target) return;
    const step = dt / this.duration;
    this.progress = this.target === 1 ? Math.min(1, this.progress + step) : Math.max(0, this.progress - step);
    const p = this.progress;
    const e = easeInOut(p);
    const { content, inBox } = this;

    this.box.group.position.x = this.boxHome + BOX_SLIDE * e;

    // The resting place moves with the box; the mat does not.
    const fromX = inBox.position.x + BOX_SLIDE * e;
    content.position.set(
      fromX + (OUT.x + this.boxHome - fromX) * e,
      inBox.position.y + (OUT.y - inBox.position.y) * e + Math.sin(Math.PI * p) * HOP,
      inBox.position.z + (OUT.z - inBox.position.z) * e,
    );
    content.scale.setScalar(inBox.scale + (1 - inBox.scale) * e);
    content.rotation.x = inBox.rotX * (1 - e);

    this.mat.visible = p > 0;
    this.mat.scale.setScalar(0.2 + 0.8 * Math.min(1, p * 2.5));
    this.lamp.intensity = 3.5 * e;

    if (this.progress === this.target) {
      if (this.target === 0) this.box.body.attach(content);
      this.onLand?.();
    }
  }

  dispose(): void {
    this.parent.remove(this.group);
    // Contents left on the mat go with it; the box goes home.
    if (this.content.parent === this.parent) this.parent.remove(this.content);
    this.box.group.position.x = this.boxHome;
    this.mat.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => mat.dispose());
      }
    });
  }
}
