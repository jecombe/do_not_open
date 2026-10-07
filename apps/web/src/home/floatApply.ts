/** How far the button may drift from its place, in px, before it bounces off an invisible wall. */
const WALL = 70;
/** How close the pointer has to come, in px from the button's edge, to push it. */
const REACH = 90;
/** Pointer speed, in px/s toward the button, below which it is left alone. */
const CALM = 700;

/**
 * The hero's boarding button, weightless: it drifts in place, a shadow under it shrinking as it
 * rises, three croquettes orbiting it. Sweep the pointer at it and it drifts off with the push,
 * spinning when hit off-centre, bounces off invisible walls and floats back. Over it, it holds
 * still, so it can always be clicked.
 */
export class FloatApply {
  private readonly body: HTMLElement;
  private readonly shadow: HTMLElement;
  private readonly kibble: HTMLElement[];
  private x = 0;
  private y = 0;
  private vx = 0;
  private vy = 0;
  private angle = 0;
  private spin = 0;
  private pointer: { x: number; y: number; t: number } | null = null;
  private over = false;
  private visible = true;
  private frame = 0;
  private last = 0;
  private readonly observer: IntersectionObserver;

  constructor(private readonly host: HTMLElement) {
    this.body = host.querySelector(".apply-body")!;
    this.shadow = host.querySelector(".apply-shadow")!;
    this.kibble = [...host.querySelectorAll<HTMLElement>(".apply-kibble")];
    this.body.addEventListener("pointerenter", this.enter);
    this.body.addEventListener("pointerleave", this.leave);
    window.addEventListener("pointermove", this.move, { passive: true });
    document.addEventListener("visibilitychange", this.wake);
    this.observer = new IntersectionObserver(([entry]) => {
      this.visible = !!entry?.isIntersecting;
      this.wake();
    });
    this.observer.observe(host);
    this.wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.body.removeEventListener("pointerenter", this.enter);
    this.body.removeEventListener("pointerleave", this.leave);
    window.removeEventListener("pointermove", this.move);
    document.removeEventListener("visibilitychange", this.wake);
  }

  private readonly enter = () => (this.over = true);
  private readonly leave = () => (this.over = false);

  private readonly wake = () => {
    cancelAnimationFrame(this.frame);
    if (this.visible && !document.hidden) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  };

  /** A pointer sweeping past gives the button a shove along its way, the faster the harder. */
  private readonly move = (e: PointerEvent) => {
    const now = performance.now();
    const before = this.pointer;
    this.pointer = { x: e.clientX, y: e.clientY, t: now };
    if (!before || this.over || now - before.t > 100) return;
    const dt = Math.max(8, now - before.t) / 1000;
    const pvx = (e.clientX - before.x) / dt;
    const pvy = (e.clientY - before.y) / dt;

    const box = this.body.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    // Distance from the pointer to the button's edge, not its centre: it is a wide button.
    const gap = Math.hypot(Math.max(0, Math.abs(e.clientX - cx) - box.width / 2), Math.max(0, Math.abs(e.clientY - cy) - box.height / 2));
    if (gap > REACH) return;
    const dx = cx - e.clientX;
    const dy = cy - e.clientY;
    const d = Math.hypot(dx, dy) || 1;
    // Only a sweep pushes it: someone coming at it calmly to click it must find it in place.
    const toward = (pvx * dx + pvy * dy) / d - CALM;
    if (toward <= 0) return;

    const push = Math.min(toward, 2400) * 0.25 * (1 - gap / REACH);
    const ix = (dx / d) * push;
    const iy = (dy / d) * push;
    this.vx += ix;
    this.vy += iy;
    // Hit off-centre, it spins: the torque of the shove around the button's middle.
    this.spin += ((-dx * iy + dy * ix) / box.width) * 0.9;
  };

  private readonly tick = (nowMs: number) => {
    const dt = Math.min(0.033, (nowMs - this.last) / 1000);
    this.last = nowMs;
    const t = nowMs / 1000;

    // Where it would drift on its own: a slow, lazy figure in the air.
    const hx = Math.sin(t * 0.9) * 6;
    const hy = Math.sin(t * 1.3 + 1) * 7 - 2;
    const ha = Math.sin(t * 0.7) * 4;

    // A soft spring home and very little drag: space, not water. Over it, it settles fast.
    const drag = this.over ? 12 : 1.6;
    this.vx += (-14 * (this.x - hx) - drag * this.vx) * dt;
    this.vy += (-14 * (this.y - hy) - drag * this.vy) * dt;
    this.spin += (-9 * (this.angle - ha) - (this.over ? 12 : 1.4) * this.spin) * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.angle += this.spin * dt;

    // The invisible walls: it bounces back, losing half its speed.
    if (Math.abs(this.x) > WALL) {
      this.x = Math.sign(this.x) * WALL;
      this.vx *= -0.5;
    }
    if (Math.abs(this.y) > WALL) {
      this.y = Math.sign(this.y) * WALL;
      this.vy *= -0.5;
    }
    this.angle = Math.max(-200, Math.min(200, this.angle));

    this.body.style.transform = `translate(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px) rotate(${this.angle.toFixed(1)}deg)`;
    // The higher it floats, the smaller and fainter its shadow.
    const lift = Math.max(0, Math.min(1, (-this.y + WALL) / (2 * WALL)));
    this.shadow.style.transform = `translateX(${this.x.toFixed(1)}px) scale(${(1.1 - lift * 0.6).toFixed(3)})`;
    this.shadow.style.opacity = (0.45 - lift * 0.3).toFixed(3);

    // The croquettes orbit on a tilted ring: in front of the button on the near side, behind it on the far side.
    const rx = this.body.offsetWidth / 2 + 22;
    const ry = this.body.offsetHeight / 2 + 14;
    this.kibble.forEach((k, i) => {
      const a = t * 1.5 + (i * Math.PI * 2) / this.kibble.length;
      const near = Math.sin(a);
      k.style.transform = `translate(${(Math.cos(a) * rx).toFixed(1)}px, ${(near * ry).toFixed(1)}px) rotate(${((t * 140 + i * 90) % 360).toFixed(0)}deg) scale(${(0.8 + near * 0.25).toFixed(3)})`;
      k.style.zIndex = near > 0 ? "2" : "0";
    });

    this.frame = requestAnimationFrame(this.tick);
  };
}
