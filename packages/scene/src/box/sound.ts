/**
 * Synthesised shake sounds: a cardboard thump per impact and, now and then,
 * a muffled complaint from inside. No audio files.
 */
export class ShakeSound {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  /** Must be called from a user gesture at least once (browser autoplay policy). */
  resume(): void {
    if (typeof AudioContext === "undefined") return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const length = this.ctx.sampleRate * 0.4;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.muted) return;
    const now = ctx.currentTime;
    const vol = 0.12 + strength * 0.5;

    // Cardboard rattle: short filtered noise burst.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 500 + Math.random() * 500;
    band.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol * 0.7, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start(now, Math.random() * 0.2, 0.15);

    // Body thump: something with mass hits the wall.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(110 + Math.random() * 30, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.11);
    const thump = ctx.createGain();
    thump.gain.setValueAtTime(vol, now);
    thump.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(thump).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  }

  /** A full box set down hard on a shelf: a heavy thud, a cardboard slap and a scuff. */
  land(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.muted) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(95, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.22);
    const thud = ctx.createGain();
    thud.gain.setValueAtTime(0.6, now);
    thud.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    osc.connect(thud).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);

    const slap = ctx.createBufferSource();
    slap.buffer = this.noise;
    slap.playbackRate.value = 0.6;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 700;
    const slapGain = ctx.createGain();
    slapGain.gain.setValueAtTime(0.35, now);
    slapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    slap.connect(low).connect(slapGain).connect(ctx.destination);
    slap.start(now, Math.random() * 0.2, 0.2);

    const scuff = ctx.createBufferSource();
    scuff.buffer = this.noise;
    const high = ctx.createBiquadFilter();
    high.type = "bandpass";
    high.frequency.value = 2500;
    high.Q.value = 1.2;
    const scuffGain = ctx.createGain();
    scuffGain.gain.setValueAtTime(0.0001, now + 0.02);
    scuffGain.gain.exponentialRampToValueAtTime(0.08, now + 0.04);
    scuffGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    scuff.connect(high).connect(scuffGain).connect(ctx.destination);
    scuff.start(now, Math.random() * 0.2, 0.14);
  }

  /** A heartbeat through cardboard: a low lub, then a softer dub. */
  heartbeat(): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    for (const [delay, vol] of [[0, 0.5], [0.22, 0.32]] as const) {
      const start = now + delay;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(70, start);
      osc.frequency.exponentialRampToValueAtTime(42, start + 0.12);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(vol, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    }
  }

  /** The vet's rubber stamp hitting the box. */
  stamp(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.muted) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1400;
    band.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start(now, Math.random() * 0.2, 0.08);
    this.impact(0.25);
  }

  /** A muffled "mrrp" heard through cardboard. */
  complaint(): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const base = 520 + Math.random() * 160;
    osc.frequency.setValueAtTime(base * 0.8, now);
    osc.frequency.linearRampToValueAtTime(base * 1.25, now + 0.12);
    osc.frequency.linearRampToValueAtTime(base * 0.9, now + 0.34);
    const formant = ctx.createBiquadFilter();
    formant.type = "bandpass";
    formant.frequency.value = 950;
    formant.Q.value = 2.5;
    const muffle = ctx.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = 800;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
    osc.connect(formant).connect(muffle).connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.4);
  }

  /** Tape tearing off cardboard: a rising band of noise. */
  rip(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.muted) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(900, now);
    band.frequency.exponentialRampToValueAtTime(4200, now + 0.45);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.55);
  }

  /** A soft two-note chime for whatever comes out of the box. `bright` false for ghosts. */
  reveal(bright = true): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    const notes = bright ? [523.25, 783.99, 1046.5] : [311.13, 369.99, 466.16];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = bright ? "triangle" : "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.09;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.14, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1.2);
    });
  }

  /** Kibble landing on cardboard. */
  tick(): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(900 + Math.random() * 500, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.04);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.07);
  }

  /** Contented rumble from inside. */
  purr(): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 27;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 24;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.12;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
    lfo.connect(lfoGain).connect(gain.gain);
    osc.connect(low).connect(gain).connect(ctx.destination);
    osc.start(now);
    lfo.start(now);
    osc.stop(now + 1.4);
    lfo.stop(now + 1.4);
  }

  /**
   * A meow in the open air, not through cardboard: "mi-a-ou" from a sawtooth through a
   * formant that opens then closes. `pitch` around 1; heavy cats meow lower. `weak` for a
   * cat that is not feeling well.
   */
  meow(pitch = 1, weak = false): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    const p = pitch * (0.94 + Math.random() * 0.12);
    const length = weak ? 0.7 : 0.55;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(520 * p, now);
    osc.frequency.linearRampToValueAtTime(780 * p, now + 0.14);
    osc.frequency.exponentialRampToValueAtTime((weak ? 330 : 430) * p, now + length);
    // A little wobble in the voice.
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = weak ? 9 : 6;
    const depth = ctx.createGain();
    depth.gain.value = (weak ? 22 : 10) * p;
    vibrato.connect(depth).connect(osc.frequency);
    const formant = ctx.createBiquadFilter();
    formant.type = "bandpass";
    formant.Q.value = 3;
    formant.frequency.setValueAtTime(800, now);
    formant.frequency.linearRampToValueAtTime(1700, now + 0.15);
    formant.frequency.exponentialRampToValueAtTime(700, now + length);
    const gain = ctx.createGain();
    const peak = weak ? 0.16 : 0.26;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.05);
    gain.gain.setValueAtTime(peak, now + length * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
    osc.connect(formant).connect(gain).connect(ctx.destination);
    osc.start(now);
    vibrato.start(now);
    osc.stop(now + length + 0.05);
    vibrato.stop(now + length + 0.05);
  }

  /** A ghost's moan: a slow, wavering "oooOOOooo" with a cold echo. */
  wail(): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(480, now + 0.6);
    osc.frequency.exponentialRampToValueAtTime(230, now + 1.5);
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 5;
    const depth = ctx.createGain();
    depth.gain.value = 14;
    vibrato.connect(depth).connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.55);
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.22;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.4;
    echo.connect(feedback).connect(echo);
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.connect(echo).connect(ctx.destination);
    osc.start(now);
    vibrato.start(now);
    osc.stop(now + 1.6);
    vibrato.stop(now + 1.6);
  }

  /** A quantum cat between two states: a burst of digital blips. */
  glitch(): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const now = ctx.currentTime;
    for (let i = 0; i < 9; i++) {
      const start = now + i * 0.045 + Math.random() * 0.02;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(300 + Math.random() * 1800, start);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.06, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.035);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.04);
    }
  }

  /** A sick cat's cough: two rough, low bursts. */
  cough(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.muted) return;
    const now = ctx.currentTime;
    for (const [delay, vol] of [[0, 0.4], [0.2, 0.28]] as const) {
      const start = now + delay;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const low = ctx.createBiquadFilter();
      low.type = "bandpass";
      low.frequency.value = 650;
      low.Q.value = 0.9;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(vol, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
      src.connect(low).connect(gain).connect(ctx.destination);
      src.start(start, Math.random() * 0.2, 0.15);
      const chest = ctx.createOscillator();
      chest.type = "sine";
      chest.frequency.setValueAtTime(170, start);
      chest.frequency.exponentialRampToValueAtTime(90, start + 0.1);
      const thump = ctx.createGain();
      thump.gain.setValueAtTime(vol * 0.6, start);
      thump.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      chest.connect(thump).connect(ctx.destination);
      chest.start(start);
      chest.stop(start + 0.13);
    }
  }

  /** Air rushing past a falling box. */
  whoosh(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || this.muted) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 0.7;
    band.frequency.setValueAtTime(2400, now);
    band.frequency.exponentialRampToValueAtTime(500, now + 0.45);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.55);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
