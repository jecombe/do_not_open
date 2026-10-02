/**
 * Recorded sounds, played through a small effects chain so one recording can give many
 * cats their own voice: higher or lower, nasal, raspy, muffled, echoing, stuttering,
 * slurred. The recordings themselves live with the app; this only knows how to play one.
 */
export interface ClipFx {
  /** Playback rate: above 1 higher and quicker, below 1 lower and slower. */
  rate?: number;
  /** Volume, 1 by default. */
  gain?: number;
  /** A resonant bump, e.g. the nasal ring of a Siamese. */
  peak?: { freq: number; q: number; db: number };
  /** Cut what is above, as through cardboard or a full belly. */
  lowpass?: number;
  /** Cut what is below, for a thin voice. */
  highpass?: number;
  /** 0 to 1: grit, by soft clipping. */
  rasp?: number;
  /** 0 to 1: how much of a cold echo comes back. */
  echo?: number;
  /** Chops the sound into short pieces, some repeated, some skipped. Pieces per second. */
  stutter?: number;
  /** Cents of slow wavering in pitch, for a cat that is not quite steady. */
  wobble?: number;
  /** Played backwards. */
  reverse?: boolean;
}

const reversedCache = new WeakMap<AudioBuffer, AudioBuffer>();

function reversed(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const hit = reversedCache.get(buffer);
  if (hit) return hit;
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) out.getChannelData(c).set(buffer.getChannelData(c).slice().reverse());
  reversedCache.set(buffer, out);
  return out;
}

function raspCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const drive = 1 + amount * 12;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

/** Plays `buffer` now with `fx`. Returns how long it lasts, in seconds. */
export function playClip(ctx: AudioContext, buffer: AudioBuffer, fx: ClipFx = {}): number {
  const now = ctx.currentTime;
  const rate = fx.rate ?? 1;
  const source = fx.reverse ? reversed(ctx, buffer) : buffer;
  const length = source.duration / rate;

  // The chain, built back to front: everything ends in `out`.
  const out = ctx.createGain();
  out.gain.value = fx.gain ?? 1;
  out.connect(ctx.destination);
  if (fx.echo) {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.24;
    const feedback = ctx.createGain();
    feedback.gain.value = fx.echo;
    const wet = ctx.createGain();
    wet.gain.value = fx.echo;
    out.connect(delay).connect(feedback).connect(delay);
    delay.connect(wet).connect(ctx.destination);
  }
  let head: AudioNode = out;
  const chain = (node: AudioNode) => {
    node.connect(head);
    head = node;
  };
  if (fx.lowpass) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = fx.lowpass;
    chain(f);
  }
  if (fx.highpass) {
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = fx.highpass;
    chain(f);
  }
  if (fx.peak) {
    const f = ctx.createBiquadFilter();
    f.type = "peaking";
    f.frequency.value = fx.peak.freq;
    f.Q.value = fx.peak.q;
    f.gain.value = fx.peak.db;
    chain(f);
  }
  if (fx.rasp) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = raspCurve(fx.rasp);
    shaper.oversample = "2x";
    chain(shaper);
  }

  const start = (offset: number, duration: number, at: number) => {
    const src = ctx.createBufferSource();
    src.buffer = source;
    src.playbackRate.value = rate;
    if (fx.wobble) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 2.6;
      const depth = ctx.createGain();
      depth.gain.value = fx.wobble;
      lfo.connect(depth).connect(src.detune);
      lfo.start(at);
      lfo.stop(at + duration / rate + 0.05);
    }
    src.connect(head);
    src.start(at, offset, duration);
  };

  if (!fx.stutter) {
    start(0, source.duration, now);
    return length;
  }
  // Short pieces in order, now and then played twice or dropped: a voice through a bad line.
  const piece = 1 / fx.stutter;
  let at = now;
  for (let offset = 0; offset < source.duration; offset += piece) {
    const roll = Math.random();
    if (roll < 0.15) continue;
    const times = roll > 0.8 ? 2 : 1;
    for (let k = 0; k < times; k++) {
      start(offset, Math.min(piece, source.duration - offset), at);
      at += piece / rate;
    }
  }
  return at - now;
}
