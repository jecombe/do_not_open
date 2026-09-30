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

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
