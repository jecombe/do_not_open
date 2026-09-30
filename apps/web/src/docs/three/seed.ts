import { BoxGeometry, Color, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { spec, type SeedField } from "@dno/game-spec";
import { outlineMaterial, toon } from "@dno/scene";
import { damp, PALETTE, Stage } from "./stage";

/** Most significant field first, so the row reads like the hex number above it. */
export const SEED_FIELDS = [...spec.seed.layout].sort((a, b) => b.offset - a.offset);

export const FIELD_COLORS: Record<SeedField, string> = {
  cosmetic: "#8C6A4A",
  room: PALETTE.cold,
  brokenThing: PALETTE.red,
  accessory: PALETTE.manifest,
  mood: PALETTE.tape,
  breed: PALETTE.sodium,
  stateRoll: PALETTE.spectral,
};

interface Parcel {
  field: SeedField;
  bits: number;
  offset: number;
  group: Group;
  body: Mesh;
  tape: Mesh;
  studs: Mesh[];
  home: Vector3;
  lift: number;
  tint: number;
  hop: number;
  label: HTMLElement;
}

const UNIT = 1;
const on = new MeshBasicMaterial({ color: PALETTE.sodium });
const off = new MeshBasicMaterial({ color: "#2A211A" });

/**
 * The 64-bit seed as a row of parcels, one per field, with one stud per bit.
 * Sealed: every parcel looks the same and the studs are noise. Opened: each parcel
 * takes its field's colour and the studs settle on the real bits.
 */
export class SeedScene {
  onHover: ((field: SeedField | null) => void) | null = null;
  onSelect: ((field: SeedField) => void) | null = null;

  private readonly stage: Stage;
  private readonly parcels: Parcel[] = [];
  private seed = 0n;
  private sealed = true;
  private active: SeedField | null = null;
  private noiseAt = 0;
  private readonly kraft = new Color(PALETTE.kraft);

  constructor(host: HTMLElement) {
    const stage = (this.stage = new Stage(host));
    stage.addGround(4.9, 1.5, -0.26);

    for (const slice of SEED_FIELDS) {
      const width = (slice.bits / 8) * UNIT;
      const group = new Group();
      group.userData.pick = slice.field;

      const geo = new BoxGeometry(width - 0.12, 0.5, 0.72);
      const body = new Mesh(geo, toon(PALETTE.kraft));
      body.add(new Mesh(geo, outlineMaterial(PALETTE.ink, 0.014)));
      const tape = new Mesh(new BoxGeometry(width - 0.1, 0.012, 0.16), toon(PALETTE.tape));
      tape.position.y = 0.256;

      const studs: Mesh[] = [];
      const studGeo = new BoxGeometry(0.07, 0.05, 0.07);
      for (let b = 0; b < slice.bits; b++) {
        const stud = new Mesh(studGeo, off);
        // Most significant bit on the left, two rows of four per byte.
        const byte = Math.floor(b / 8);
        const inByte = b % 8;
        stud.position.set(-width / 2 + byte * UNIT + 0.2 + (inByte % 4) * 0.2, 0.275, inByte < 4 ? -0.2 : 0.2);
        studs.push(stud);
        group.add(stud);
      }
      group.add(body, tape);
      stage.scene.add(group);
      stage.pickables.push(group);
      const label = stage.addLabel("seed-hex", new Vector3(0, 0.62, 0), group);
      this.parcels.push({ field: slice.field, bits: slice.bits, offset: slice.offset, group, body, tape, studs, home: new Vector3(), lift: 0, tint: 0, hop: 0, label });
    }

    stage.onHover = (id) => this.onHover?.(id as SeedField | null);
    stage.onSelect = (id) => this.onSelect?.(id as SeedField);
    stage.onLayout = (aspect) => this.layout(aspect);
    stage.onFrame((time, dt) => this.update(time, dt));
    this.layout(stage.camera.aspect);
    for (const p of this.parcels) p.group.position.copy(p.home);
  }

  setSeed(seed: bigint): void {
    this.seed = seed;
    for (const p of this.parcels) p.hop = 1;
    this.paint();
    this.stage.wake();
  }

  setSealed(sealed: boolean): void {
    this.sealed = sealed;
    this.paint();
    this.stage.wake();
  }

  setActive(field: SeedField | null): void {
    this.active = field;
    this.stage.wake();
  }

  dispose(): void {
    this.stage.dispose();
  }

  /** One row when there is room, two rows of four bytes on a narrow screen. */
  private layout(aspect: number): void {
    const narrow = aspect < 1.15;
    let x = 0;
    let row = 0;
    const rows: Parcel[][] = [[], []];
    for (const p of this.parcels) {
      const width = (p.bits / 8) * UNIT;
      if (narrow && x + width > 4 * UNIT + 0.01) {
        row = 1;
        x = 0;
      }
      p.home.set(x + width / 2, 0, 0);
      rows[row]!.push(p);
      x += width;
    }
    const total = narrow ? 4 * UNIT : 8 * UNIT;
    rows.forEach((list, r) => {
      for (const p of list) {
        p.home.x -= total / 2;
        p.home.z = narrow ? (r === 0 ? -0.75 : 0.75) : 0;
      }
    });
    const center = new Vector3(0, 0.1, 0);
    if (narrow) this.stage.frame(center, 4.9, 4.0, new Vector3(0, 1.15, 1));
    else this.stage.frame(center, 8.7, 2.5, new Vector3(0, 0.62, 1));
  }

  private valueOf(p: Parcel): number {
    return Number((this.seed >> BigInt(p.offset)) & ((1n << BigInt(p.bits)) - 1n));
  }

  /** Labels and studs for the current seed. Sealed studs are repainted as noise each frame. */
  private paint(): void {
    for (const p of this.parcels) {
      const value = this.valueOf(p);
      const digits = p.bits / 4;
      p.label.textContent = this.sealed ? "?".repeat(digits) : value.toString(16).padStart(digits, "0");
      p.label.classList.toggle("is-sealed", this.sealed);
      if (this.sealed) continue;
      p.studs.forEach((stud, b) => {
        stud.material = (value >> (p.bits - 1 - b)) & 1 ? on : off;
      });
    }
  }

  private update(time: number, dt: number): void {
    const rate = this.stage.reduced ? 60 : 9;
    // Ciphertext looks like noise: reshuffle the studs a dozen times a second.
    if (this.sealed && time - this.noiseAt > (this.stage.reduced ? 1.5 : 0.085)) {
      this.noiseAt = time;
      for (const p of this.parcels) for (const stud of p.studs) stud.material = Math.random() < 0.5 ? on : off;
    }
    for (const p of this.parcels) {
      p.lift = damp(p.lift, p.field === this.active ? 1 : 0, rate, dt);
      p.tint = damp(p.tint, this.sealed ? 0 : 1, rate * 0.6, dt);
      p.hop = damp(p.hop, 0, 5, dt);
      p.group.position.x = damp(p.group.position.x, p.home.x, rate, dt);
      p.group.position.z = damp(p.group.position.z, p.home.z, rate, dt);
      p.group.position.y = p.lift * 0.28 + (this.stage.reduced ? 0 : Math.sin(p.hop * Math.PI) * 0.22);
      p.group.rotation.z = (1 - p.tint) * 0 + p.lift * -0.03;
      (p.body.material as ReturnType<typeof toon>).color.copy(this.kraft).lerp(new Color(FIELD_COLORS[p.field]), p.tint);
      // The tape comes off as the parcel opens.
      p.tape.scale.x = Math.max(0.001, 1 - p.tint);
      p.tape.visible = p.tint < 0.98;
    }
  }
}
