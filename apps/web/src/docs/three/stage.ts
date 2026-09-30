import {
  CanvasTexture,
  CircleGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

export interface StageLabel {
  el: HTMLElement;
  at: Vector3;
  /** Follows this object if set, offset by `at`. */
  follow?: Object3D;
}

export const PALETTE = {
  shadow: "#17130F",
  kraft: "#B8895A",
  tape: "#D9C28A",
  red: "#C2261D",
  manifest: "#E9DFC8",
  sodium: "#FFB454",
  spectral: "#7DE3D0",
  ink: "#1C1814",
  steel: "#3A4652",
  bench: "#6B4A2E",
  cold: "#8496AD",
} as const;

const tmp = new Vector3();

/**
 * One diagram: a transparent WebGL canvas with HTML labels pinned to 3D points.
 * It renders only while it is on screen, and holds still under prefers-reduced-motion
 * except when something changes.
 */
export class Stage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(32, 1, 0.1, 80);
  readonly reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Objects the pointer can hit. Each carries `userData.pick`. */
  readonly pickables: Object3D[] = [];
  onHover: ((id: string | null) => void) | null = null;
  onSelect: ((id: string) => void) | null = null;
  /** Called on every resize with width / height, to let a scene reframe itself. */
  onLayout: ((aspect: number) => void) | null = null;

  private readonly renderer: WebGLRenderer;
  private readonly layer: HTMLDivElement;
  private readonly labels: StageLabel[] = [];
  private readonly frameCallbacks: ((time: number, dt: number) => void)[] = [];
  private readonly raycaster = new Raycaster();
  private readonly resize: ResizeObserver;
  private readonly watch: IntersectionObserver;
  private visible = false;
  private raf = 0;
  private last = 0;
  private time = 0;
  private hovered: string | null = null;
  private disposed = false;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearAlpha(0);
    const canvas = this.renderer.domElement;
    canvas.setAttribute("aria-hidden", "true");
    this.layer = document.createElement("div");
    this.layer.className = "stage-labels";
    this.layer.setAttribute("aria-hidden", "true");
    host.append(canvas, this.layer);

    this.scene.add(new HemisphereLight("#AEB9C9", "#2A2018", 1.25));
    const key = new DirectionalLight("#FFD9A8", 2.1);
    key.position.set(3, 6, 5);
    const rim = new DirectionalLight(PALETTE.cold, 0.9);
    rim.position.set(-5, 3, -4);
    this.scene.add(key, rim);

    canvas.addEventListener("pointermove", this.pointerMove);
    canvas.addEventListener("pointerleave", this.pointerLeave);
    canvas.addEventListener("click", this.click);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.watch = new IntersectionObserver(([entry]) => {
      this.visible = !!entry?.isIntersecting;
      if (this.visible) this.wake();
    });
    this.watch.observe(host);
    this.fit();
  }

  /** A soft dark disc under the subject, so it sits on something. */
  addGround(radiusX: number, radiusZ: number, y = 0): Mesh {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grad.addColorStop(0, "rgba(0,0,0,0.5)");
    grad.addColorStop(0.55, "rgba(0,0,0,0.22)");
    grad.addColorStop(0.85, "rgba(0,0,0,0.04)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const ground = new Mesh(new CircleGeometry(1, 48), new MeshBasicMaterial({ map: new CanvasTexture(c), transparent: true, depthWrite: false }));
    ground.rotation.x = -Math.PI / 2;
    ground.scale.set(radiusX, radiusZ, 1);
    ground.position.y = y;
    this.scene.add(ground);
    return ground;
  }

  addLabel(className: string, at: Vector3, follow?: Object3D): HTMLElement {
    const el = document.createElement("span");
    el.className = `stage-label ${className}`;
    this.layer.append(el);
    this.labels.push({ el, at, follow });
    return el;
  }

  onFrame(callback: (time: number, dt: number) => void): void {
    this.frameCallbacks.push(callback);
  }

  /**
   * Puts the camera along `direction` from `center`, far enough for a box of
   * `width` x `height` to fit whatever the aspect ratio.
   */
  frame(center: Vector3, width: number, height: number, direction: Vector3): void {
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    const distance = Math.max(height / 2 / t, width / 2 / (t * this.camera.aspect));
    this.camera.position.copy(center).addScaledVector(tmp.copy(direction).normalize(), distance);
    this.camera.lookAt(center);
  }

  /** Asks for frames again after a state change made while the stage was idle. */
  wake(): void {
    if (this.raf || this.disposed) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.watch.disconnect();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.layer.remove();
  }

  private readonly tick = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    for (const cb of this.frameCallbacks) cb(this.time, dt);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
    this.raf = requestAnimationFrame(this.tick);
  };

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.onLayout?.(w / h);
    this.camera.updateProjectionMatrix();
    this.wake();
  }

  private placeLabels(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    for (const label of this.labels) {
      if (label.follow) label.follow.getWorldPosition(tmp).add(label.at);
      else tmp.copy(label.at);
      tmp.project(this.camera);
      const x = (tmp.x * 0.5 + 0.5) * w;
      const y = (-tmp.y * 0.5 + 0.5) * h;
      label.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  private pick(event: PointerEvent | MouseEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const point = new Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(point, this.camera);
    for (const hit of this.raycaster.intersectObjects(this.pickables, true)) {
      for (let o: Object3D | null = hit.object; o; o = o.parent) {
        if (typeof o.userData.pick === "string") return o.userData.pick;
      }
    }
    return null;
  }

  private readonly pointerMove = (event: PointerEvent) => {
    const id = this.pick(event);
    if (id === this.hovered) return;
    this.hovered = id;
    this.renderer.domElement.style.cursor = id ? "pointer" : "";
    this.onHover?.(id);
  };

  private readonly pointerLeave = () => {
    if (this.hovered === null) return;
    this.hovered = null;
    this.onHover?.(null);
  };

  private readonly click = (event: MouseEvent) => {
    const id = this.pick(event);
    if (id) this.onSelect?.(id);
  };
}

/** Frame-rate independent approach of `current` towards `target`. */
export const damp = (current: number, target: number, rate: number, dt: number) => current + (target - current) * (1 - Math.exp(-rate * dt));
