import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  Vector4,
} from "three";
import { spec } from "@dno/game-spec";
import { buildBoxSpec } from "@dno/generator";
import { BOX_SIZE, createBox, type BoxObject } from "@dno/scene";
import { Stage } from "../docs/three/stage";

/** The shield around the box, and how far out a probe starts. */
const R = 1.35;
const START = 4.2;
/** Seconds between two probes on their own, and how fast one flies. */
const EVERY = 1.7;
const SPEED = 2.6;
/** Ripples the shield shows at once (the shader's array). */
const HITS = 4;
const TEAL = new Color("#5BE3C2");
const RED = new Color("#FF4D3D");
const GLYPHS = "0123456789abcdef▓▒░█";

export const scramble = (n: number) => Array.from({ length: n }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join("");

/**
 * The shield's skin: it glows at its rim, scans slowly, and ripples where it is hit. Each of
 * `uHits` is a unit direction in the sphere's own frame and the time it landed; `uFade` dims it.
 */
export function shieldGlow(hits: number): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uColor: { value: TEAL },
      uHit: { value: new Color("#9FFFE9") },
      uHits: {
        value: Array.from({ length: hits }, () => new Vector4(0, 1, 0, -99)),
      },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal;
      void main() {
        vLocal = normalize(position);
        vec4 world = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-world.xyz);
        gl_Position = projectionMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uFade; uniform vec3 uColor; uniform vec3 uHit; uniform vec4 uHits[${hits}];
      varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal;
      void main() {
        float rim = pow(1.0 - abs(dot(vNormal, vView)), 2.6);
        float scan = 0.5 + 0.5 * sin(vLocal.y * 40.0 - uTime * 3.0);
        float a = rim * (0.32 + 0.1 * scan);
        vec3 color = uColor * a;
        for (int i = 0; i < ${hits}; i++) {
          float age = uTime - uHits[i].w;
          if (age < 0.0 || age > 1.4) continue;
          float d = acos(clamp(dot(vLocal, uHits[i].xyz), -1.0, 1.0));
          float ring = smoothstep(0.09, 0.0, abs(d - age * 1.3)) * (1.0 - age / 1.4);
          float core = smoothstep(0.35, 0.0, d) * max(0.0, 1.0 - age * 3.0);
          color += uHit * (ring * 0.9 + core * 0.8);
          a += ring + core;
        }
        gl_FragColor = vec4(color * uFade, min(a, 1.0) * uFade);
      }`,
  });
}

interface Probe {
  dot: Mesh;
  trail: Line;
  dir: Vector3;
  /** Distance from the centre. */
  r: number;
}

/**
 * The secure home page's picture: a sealed box inside an encryption shield. Probes fly at it
 * from every side, trying to read who holds it; each one hits the shield, which ripples where it
 * landed, and a "refused" tag flashes there. The holder's tag above the box only ever shows
 * ciphertext, unless the page reveals it to its holder. A click sends a probe at once. Under
 * reduced motion it holds still.
 */
export class ShieldScene {
  private readonly stage: Stage;
  private readonly box: BoxObject;
  private readonly shell: Group;
  private readonly glow: ShaderMaterial;
  private readonly rings: Group;
  private readonly holder: HTMLElement;
  private readonly denied: { el: HTMLElement; at: Vector3 }[] = [];
  private readonly probes: Probe[] = [];
  private readonly probeGeometry = new SphereGeometry(0.035, 12, 8);
  private readonly probeMaterial = new MeshBasicMaterial({ color: RED });
  private hit = 0;
  private time = 0;
  private next = 0.6;
  private scrambleAt = 0;
  /** Once set, the holder's tag shows it instead of ciphertext. */
  private known: string | null = null;

  constructor(host: HTMLElement, labels: { holder: string; denied: string }) {
    const stage = (this.stage = new Stage(host));

    const box = (this.box = createBox(buildBoxSpec(Math.floor(Math.random() * spec.collection.maxSupply))));
    box.group.position.y = -BOX_SIZE.height / 2;
    stage.scene.add(box.group);
    const cold = new PointLight(TEAL, 6, 6, 1.6);
    cold.position.set(-1.6, 1.2, 1.4);
    stage.scene.add(cold);

    // The shield: a slow lattice, and a sphere that glows at its rim and ripples where it is hit.
    this.shell = new Group();
    const lattice = new LineSegments(
      new EdgesGeometry(new IcosahedronGeometry(R, 1)),
      new LineBasicMaterial({
        color: TEAL,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    this.glow = shieldGlow(HITS);
    this.shell.add(lattice, new Mesh(new SphereGeometry(R, 64, 40), this.glow));
    stage.scene.add(this.shell);

    // Two tilted orbits, each with a packet running along it.
    this.rings = new Group();
    for (const [tilt, radius] of [
      [0.5, R * 1.16],
      [-0.9, R * 1.28],
    ] as const) {
      const ring = new Group();
      ring.rotation.set(Math.PI / 2 + tilt, tilt * 0.6, 0);
      ring.add(
        new Mesh(
          new TorusGeometry(radius, 0.004, 6, 160),
          new MeshBasicMaterial({
            color: TEAL,
            transparent: true,
            opacity: 0.45,
          })
        )
      );
      const packet = new Mesh(new SphereGeometry(0.03, 10, 8), new MeshBasicMaterial({ color: TEAL }));
      packet.position.x = radius;
      ring.add(packet);
      this.rings.add(ring);
    }
    stage.scene.add(this.rings);

    this.holder = stage.addLabel("shield-holder", new Vector3(0, BOX_SIZE.height / 2 + 0.3, 0));
    this.holder.dataset.label = labels.holder;
    this.holder.textContent = `${labels.holder} ${scramble(10)}`;
    for (let i = 0; i < HITS; i++) {
      // The stage keeps this vector, so moving it moves the tag.
      const at = new Vector3();
      const el = stage.addLabel("shield-denied", at);
      el.textContent = labels.denied;
      this.denied.push({ el, at });
    }

    stage.onSelect = () => this.probe();
    stage.pickables.push(this.shell);
    this.shell.userData.pick = "shield";
    stage.onLayout = () => stage.frame(new Vector3(0, 0, 0), R * 2.7, R * 2.6, new Vector3(0.18, 0.26, 1));
    stage.onLayout(1);
    stage.onFrame((_t, dt) => this.update(dt));
    this.update(0);
  }

  /** Sends a probe from a random side at the box. */
  probe(): void {
    const dir = new Vector3(Math.random() * 2 - 1, Math.random() * 1.2 - 0.4, Math.random() * 1.4 - 0.2).normalize();
    const dot = new Mesh(this.probeGeometry, this.probeMaterial);
    const trail = new Line(new BufferGeometry(), new LineBasicMaterial({ color: RED, transparent: true, opacity: 0.6 }));
    trail.geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
    this.stage.scene.add(dot, trail);
    this.probes.push({ dot, trail, dir, r: START });
    this.stage.wake();
  }

  /** Shows who holds the box to its holder, or goes back to ciphertext with null. */
  reveal(text: string | null): void {
    this.known = text;
    this.holder.classList.toggle("is-known", text !== null);
    this.holder.textContent = text ?? `${this.holder.dataset.label} ${scramble(10)}`;
    this.stage.wake();
  }

  dispose(): void {
    this.box.group.removeFromParent();
    this.box.dispose();
    this.probeGeometry.dispose();
    this.probeMaterial.dispose();
    this.stage.dispose();
  }

  private update(dt: number): void {
    if (this.stage.reduced) return;
    this.time += dt;
    const t = this.time;
    this.glow.uniforms.uTime!.value = t;
    this.box.group.rotation.y = -0.5 + Math.sin(t * 0.35) * 0.35;
    this.box.group.position.y = -BOX_SIZE.height / 2 + Math.sin(t * 1.1) * 0.03;
    this.shell.rotation.y = t * 0.08;
    this.rings.children.forEach((ring, i) => (ring.rotation.z = t * (i ? -0.5 : 0.35)));

    if (this.known === null && t > this.scrambleAt) {
      this.scrambleAt = t + 0.09;
      this.holder.textContent = `${this.holder.dataset.label} ${scramble(10)}`;
    }

    if (t > this.next) {
      this.next = t + EVERY * (0.7 + Math.random() * 0.6);
      this.probe();
    }

    for (const p of [...this.probes]) {
      p.r -= SPEED * dt;
      const at = p.dir.clone().multiplyScalar(Math.max(p.r, R));
      p.dot.position.copy(at);
      const tail = p.dir.clone().multiplyScalar(Math.min(p.r + 0.7, START));
      const pos = p.trail.geometry.getAttribute("position") as Float32BufferAttribute;
      pos.setXYZ(0, at.x, at.y, at.z);
      pos.setXYZ(1, tail.x, tail.y, tail.z);
      pos.needsUpdate = true;
      if (p.r > R) continue;
      // It landed: a ripple where it hit, in the shield's own turning frame, and the tag.
      const local = this.shell.worldToLocal(at.clone()).normalize();
      const slot = this.hit++ % HITS;
      (this.glow.uniforms.uHits!.value as Vector4[])[slot]!.set(local.x, local.y, local.z, t);
      const tag = this.denied[slot]!;
      tag.at.copy(at.multiplyScalar(1.08));
      tag.el.classList.remove("on");
      void tag.el.offsetWidth;
      tag.el.classList.add("on");
      p.dot.removeFromParent();
      p.trail.removeFromParent();
      p.trail.geometry.dispose();
      (p.trail.material as LineBasicMaterial).dispose();
      this.probes.splice(this.probes.indexOf(p), 1);
    }
  }
}
