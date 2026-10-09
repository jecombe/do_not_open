/** What the field is made of: hex and shaded blocks, like every ciphertext on these pages. */
const GLYPHS = "0123456789abcdef▓▒░";
/** Cell size in CSS pixels, how far the pointer's light reaches, and how fast a click's ring runs. */
const CELL = 22;
const REACH = 130;
const RING_SPEED = 900;
const RING_WIDTH = 46;
/** Glyphs that change on their own each second, as a share of the field. */
const DRIFT = 0.03;

interface Ring {
  x: number;
  y: number;
  /** Seconds since the click. */
  age: number;
}

const pick = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;

/**
 * The page's background: a faint field of ciphertext that never settles. Where the pointer
 * passes, the glyphs warm up to teal, lean away from it and scramble, and the trail cools off
 * behind it. A click (or a tap) sends a ring through the field and drops a padlock that snaps
 * shut where it landed. It draws only what changes on top of a still layer, stops when the tab
 * is hidden, and under reduced motion shows the still field only.
 */
export class CipherField {
  private readonly ctx: CanvasRenderingContext2D;
  /** The quiet glyphs, redrawn a few cells at a time. */
  private readonly still = document.createElement("canvas");
  private readonly stillCtx: CanvasRenderingContext2D;
  private readonly reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private cols = 0;
  private rows = 0;
  private glyphs: string[] = [];
  /** How lit each cell is, 0 to 1; it cools every frame. */
  private heat = new Float32Array(0);
  private rings: Ring[] = [];
  private pointer = { x: -9999, y: -9999, seen: false };
  private dpr = 1;
  private raf = 0;
  private last = 0;
  /** Set when only the slow drift is left to draw, which then runs at a low rate. */
  private calm = false;
  private sinceDraw = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.stillCtx = this.still.getContext("2d")!;
    this.fit();
    window.addEventListener("resize", this.fit);
    window.addEventListener("pointermove", this.move, { passive: true });
    window.addEventListener("pointerdown", this.down, { passive: true });
    document.addEventListener("pointerleave", this.leave);
    document.addEventListener("visibilitychange", this.wake);
    this.wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.fit);
    window.removeEventListener("pointermove", this.move);
    window.removeEventListener("pointerdown", this.down);
    document.removeEventListener("pointerleave", this.leave);
    document.removeEventListener("visibilitychange", this.wake);
  }

  private readonly fit = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.canvas, this.still]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.cols = Math.ceil(w / CELL) + 1;
    this.rows = Math.ceil(h / CELL) + 1;
    this.glyphs = Array.from({ length: this.cols * this.rows }, pick);
    this.heat = new Float32Array(this.cols * this.rows);
    const s = this.stillCtx;
    s.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    s.font = `11px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    s.textAlign = "center";
    s.textBaseline = "middle";
    s.clearRect(0, 0, w, h);
    for (let i = 0; i < this.glyphs.length; i++) this.drawStill(i);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.font = s.font;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.render(0);
  };

  private drawStill(i: number): void {
    const x = (i % this.cols) * CELL + CELL / 2;
    const y = Math.floor(i / this.cols) * CELL + CELL / 2;
    const s = this.stillCtx;
    s.clearRect(x - CELL / 2, y - CELL / 2, CELL, CELL);
    // A slow vignette: brighter towards the top, where the hero is.
    const a = 0.035 + 0.04 * (1 - y / (this.rows * CELL));
    s.fillStyle = `rgba(139,151,166,${a.toFixed(3)})`;
    s.fillText(this.glyphs[i]!, x, y);
  }

  private readonly move = (e: PointerEvent) => {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.seen = e.pointerType === "mouse" || e.pointerType === "pen";
    this.wake();
  };

  private readonly down = (e: PointerEvent) => {
    if (this.reduced) return;
    this.rings.push({ x: e.clientX, y: e.clientY, age: 0 });
    if (this.rings.length > 4) this.rings.shift();
    this.wake();
  };

  private readonly leave = () => {
    this.pointer.seen = false;
  };

  private readonly wake = () => {
    if (this.reduced || this.raf || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  };

  private readonly tick = (now: number) => {
    this.raf = 0;
    if (document.hidden) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.sinceDraw += dt;
    if (!this.calm || this.sinceDraw > 1 / 12) {
      this.render(this.sinceDraw);
      this.sinceDraw = 0;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private render(dt: number): void {
    const { cols, rows, heat, glyphs } = this;
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    // The quiet field drifts: a few glyphs change every frame.
    const changes = Math.ceil(glyphs.length * DRIFT * dt);
    for (let k = 0; k < changes; k++) {
      const i = Math.floor(Math.random() * glyphs.length);
      glyphs[i] = pick();
      this.drawStill(i);
    }

    // The pointer warms the cells around it.
    const { x: px, y: py, seen } = this.pointer;
    if (seen) {
      const c0 = Math.max(0, Math.floor((px - REACH) / CELL));
      const c1 = Math.min(cols - 1, Math.ceil((px + REACH) / CELL));
      const r0 = Math.max(0, Math.floor((py - REACH) / CELL));
      const r1 = Math.min(rows - 1, Math.ceil((py + REACH) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(c * CELL + CELL / 2 - px, r * CELL + CELL / 2 - py);
          if (d > REACH) continue;
          const i = r * cols + c;
          const k = 1 - d / REACH;
          heat[i] = Math.max(heat[i]!, k * k);
        }
      }
    }

    // Click rings light the cells they cross.
    for (const ring of this.rings) {
      ring.age += dt;
      const radius = ring.age * RING_SPEED;
      const fade = Math.max(0, 1 - ring.age / 1.4);
      const c0 = Math.max(0, Math.floor((ring.x - radius - RING_WIDTH) / CELL));
      const c1 = Math.min(cols - 1, Math.ceil((ring.x + radius + RING_WIDTH) / CELL));
      const r0 = Math.max(0, Math.floor((ring.y - radius - RING_WIDTH) / CELL));
      const r1 = Math.min(rows - 1, Math.ceil((ring.y + radius + RING_WIDTH) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.abs(Math.hypot(c * CELL + CELL / 2 - ring.x, r * CELL + CELL / 2 - ring.y) - radius);
          if (d > RING_WIDTH) continue;
          const i = r * cols + c;
          heat[i] = Math.max(heat[i]!, (1 - d / RING_WIDTH) * fade * 0.8);
        }
      }
    }
    this.rings = this.rings.filter((ring) => ring.age < 1.6);

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.still, 0, 0, w, h);

    // Lit cells: drawn over the still field, leaning away from the pointer, scrambling while hot.
    let hot = false;
    for (let i = 0; i < heat.length; i++) {
      const k = heat[i]!;
      if (k < 0.02) {
        if (k > 0) {
          // Cooled down: the still layer takes the glyph it ended on.
          heat[i] = 0;
          this.drawStill(i);
        }
        continue;
      }
      hot = true;
      const c = i % cols;
      const r = Math.floor(i / cols);
      let x = c * CELL + CELL / 2;
      let y = r * CELL + CELL / 2;
      if (seen) {
        const dx = x - px;
        const dy = y - py;
        const d = Math.hypot(dx, dy) || 1;
        const push = Math.max(0, 1 - d / REACH) * 7;
        x += (dx / d) * push;
        y += (dy / d) * push;
      }
      if (Math.random() < k * 0.35) glyphs[i] = pick();
      ctx.clearRect(c * CELL, r * CELL, CELL, CELL);
      ctx.fillStyle = `rgba(91,227,194,${(0.06 + k * 0.34).toFixed(3)})`;
      ctx.fillText(glyphs[i]!, x, y);
      heat[i] = k * Math.exp(-dt * 3.4);
    }

    for (const ring of this.rings) this.drawLock(ring);

    this.calm = !hot && !this.rings.length && !seen;
  }

  /** A padlock that pops where the click landed, its shackle snapping shut, then fades. */
  private drawLock(ring: Ring): void {
    const ctx = this.ctx;
    const t = ring.age;
    const pop = Math.min(1, t / 0.18);
    const scale = 0.6 + 0.5 * pop - 0.1 * Math.min(1, Math.max(0, (t - 0.18) / 0.2));
    const alpha = Math.max(0, 1 - Math.max(0, t - 0.5) / 0.7);
    if (alpha <= 0) return;
    // The shackle is up at first, and drops into the body.
    const lift = 5 * (1 - Math.min(1, Math.max(0, (t - 0.12) / 0.16)));
    ctx.save();
    ctx.translate(ring.x, ring.y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#5BE3C2";
    ctx.fillStyle = "rgba(91,227,194,0.16)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-6, -2 - lift);
    ctx.lineTo(-6, -8 - lift);
    ctx.arc(0, -8 - lift, 6, Math.PI, 0);
    ctx.lineTo(6, -2 - lift * 0.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(-10, -2, 20, 15, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#5BE3C2";
    ctx.fillRect(-1, 3, 2, 5);
    ctx.restore();
  }
}
