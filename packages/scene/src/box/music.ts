/** How loud the music sits under everything else: about -22 dB. */
const LEVEL = 0.08;
const FADE_IN = 4;
const FADE_OUT = 0.6;

const BPM = 108;
/** A swung eighth: the long one, then the short one. */
const SWING = 0.62;
/** C, A minor, F, G: a root under each bar and the chord stabbed on the off-beats. */
const BARS: Array<[number, number[]]> = [
  [48, [60, 64, 67]],
  [45, [57, 60, 64]],
  [41, [57, 60, 65]],
  [43, [55, 59, 62]],
];
/** C major pentatonic, where the xylophone wanders. */
const TUNE = [72, 74, 76, 79, 81, 84];
const WALK = [-2, -1, -1, 0, 1, 1, 2];

const mtof = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * A discreet cartoon tune behind the game: pizzicato oom-pah, a xylophone that wanders,
 * a "boing" now and then. Generated as it plays, so it never quite repeats and needs no
 * file. Like every sound here it can only start after a click (browser autoplay policy);
 * it sleeps while the tab is hidden.
 */
export class CartoonMusic {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private at = 0;
  private step = 0;
  private note = 2;
  private readonly onVisibility = () => {
    if (!this.ctx || !this.timer) return;
    if (document.hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  };

  get playing(): boolean {
    return this.timer !== null;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  start(): void {
    if (this.timer || typeof AudioContext === "undefined") return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    const ctx = this.ctx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(LEVEL, now + FADE_IN);
    this.out.connect(ctx.destination);
    this.at = now + 0.2;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), 50);
  }

  stop(): void {
    if (!this.timer || !this.ctx || !this.out) return;
    clearInterval(this.timer);
    this.timer = null;
    const out = this.out;
    const now = this.ctx.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(0, now + FADE_OUT);
    setTimeout(() => out.disconnect(), (FADE_OUT + 0.6) * 1000);
    this.out = null;
  }

  dispose(): void {
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibility);
    void this.ctx?.close();
    this.ctx = null;
  }

  /** Lays down every eighth due in the next half second. */
  private schedule(): void {
    const ctx = this.ctx!;
    const beat = 60 / BPM;
    while (this.at < ctx.currentTime + 0.5) {
      const t = this.at;
      const bar = Math.floor(this.step / 8);
      const [root, chord] = BARS[bar % BARS.length]!;
      const eighth = this.step % 8;
      const onBeat = eighth % 2 === 0;
      const beatInBar = eighth >> 1;
      if (onBeat) {
        if (beatInBar % 2 === 0) this.blip(t, mtof(beatInBar === 0 ? root : root + 7), "triangle", 0.22, 0.16);
        else chord.forEach((n, i) => this.blip(t, mtof(n), "square", 0.09, 0.018, i - 1));
      }
      // Every fourth bar the tune rests, so it breathes.
      if (bar % 4 !== 3 && Math.random() < (onBeat ? 0.6 : 0.35)) {
        this.note = Math.max(0, Math.min(TUNE.length - 1, this.note + WALK[Math.floor(Math.random() * WALK.length)]!));
        this.xylo(t, TUNE[this.note]!);
      }
      if (this.step % 64 === 60 && Math.random() < 0.7) this.boing(t);
      this.step++;
      this.at += beat * (onBeat ? SWING : 1 - SWING);
    }
  }

  private blip(t: number, freq: number, type: OscillatorType, dur: number, amp: number, pan = 0): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(amp, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    osc.connect(gain).connect(panner).connect(this.out!);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private xylo(t: number, midi: number): void {
    const freq = mtof(midi);
    const pan = Math.random() * 0.6 - 0.3;
    this.blip(t, freq, "sine", 0.45, 0.09, pan);
    // The bar's bright overtone, gone almost at once.
    this.blip(t, freq * 4, "sine", 0.08, 0.03, pan);
  }

  private boing(t: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(620, t + 0.12);
    osc.frequency.exponentialRampToValueAtTime(260, t + 0.5);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 14;
    const depth = ctx.createGain();
    depth.gain.value = 30;
    wobble.connect(depth).connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.07, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(gain).connect(this.out!);
    for (const o of [osc, wobble]) {
      o.start(t);
      o.stop(t + 0.65);
    }
  }
}
