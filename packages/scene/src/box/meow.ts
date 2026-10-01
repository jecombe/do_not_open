/**
 * Synthesised meows. A meow is a voice (the throat: how high, how bright, how rough)
 * saying a phrase (the words: one long "miaou", a trill, a chatter...). Mixing the two
 * gives every kind of cat its own sound without a single audio file.
 */

/** The throat. Frequencies in Hz; the 0..1 knobs default to 0. */
export interface MeowVoice {
  /** Fundamental the phrase contours scale. Kittens ~650, big cats ~360. */
  pitch: number;
  /** Centre of the mouth formant, which the phrase opens and closes around. */
  formant: number;
  /** Sharpness of that formant: high is nasal and piercing, low is round. */
  q: number;
  /** Breath noise mixed into the voice: raspy. */
  rasp?: number;
  /** Slow amplitude flutter of a rumbling throat. */
  growl?: number;
  /** Extra resonance near 2.7 kHz, the Siamese whine. */
  nasal?: number;
  /** Heard through fur and blanket: high frequencies rolled off. */
  muffled?: boolean;
  /** A cold echo trailing the voice. */
  echo?: number;
  /** Chops the voice into bits, like a bad connection. Rate in Hz. */
  stutter?: number;
  /** Overall loudness around 1. */
  loud?: number;
}

/** One sound in a phrase. Contours are ratios of the voice: [start, peak, end]. */
interface Syllable {
  /** Seconds after the phrase starts. */
  at: number;
  dur: number;
  pitch: [number, number, number];
  /** Formant opening, as a ratio of the voice formant. */
  open: [number, number, number];
  /** Where the peak falls, as a fraction of the syllable. */
  peakAt: number;
  /** Rolled "rrr": amplitude flutter in Hz. */
  trill?: number;
  /** Vibrato [rate Hz, depth as a ratio of the pitch]. */
  vibrato?: [number, number];
  amp?: number;
  /** Breath only, no voiced tone: the silent meow. */
  whisper?: boolean;
}

export type MeowPhrase =
  | "miaou"
  | "mew"
  | "doubleMew"
  | "trill"
  | "question"
  | "yowl"
  | "demand"
  | "plaintive"
  | "chatter"
  | "grumble"
  | "drawl"
  | "hungry"
  | "silent"
  | "om";

const syl = (s: Partial<Syllable> & Pick<Syllable, "dur" | "pitch">): Syllable => ({
  at: 0,
  open: [0.7, 1.3, 0.6],
  peakAt: 0.25,
  ...s,
});

export const MEOW_PHRASES: Record<MeowPhrase, Syllable[]> = {
  /** The textbook "mi-a-ou". */
  miaou: [syl({ dur: 0.55, pitch: [1, 1.5, 0.82] })],
  /** A kitten's short squeak. */
  mew: [syl({ dur: 0.2, pitch: [1.25, 1.45, 1.15], open: [0.9, 1.2, 0.9], peakAt: 0.4 })],
  doubleMew: [
    syl({ dur: 0.2, pitch: [1.2, 1.45, 1.1], open: [0.9, 1.2, 0.9], peakAt: 0.4 }),
    syl({ at: 0.26, dur: 0.24, pitch: [1.25, 1.55, 1.05], open: [0.9, 1.3, 0.8], peakAt: 0.4 }),
  ],
  /** "Mrrrp": a rolled, rising greeting. */
  trill: [syl({ dur: 0.34, pitch: [0.82, 1.12, 1.08], open: [0.55, 0.9, 0.8], peakAt: 0.6, trill: 27 })],
  /** "Mrrow?" with the end going up. */
  question: [syl({ dur: 0.5, pitch: [0.9, 0.95, 1.45], open: [0.6, 1.1, 1.2], peakAt: 0.35 })],
  /** A long, loud "mee-OWWW". */
  yowl: [syl({ dur: 1.1, pitch: [0.95, 1.65, 1.05], open: [0.7, 1.5, 0.55], peakAt: 0.45, vibrato: [6, 0.03], amp: 1.1 })],
  /** A short, flat "MRAOW" that expects results. */
  demand: [syl({ dur: 0.38, pitch: [0.78, 1.2, 0.72], open: [0.8, 1.5, 0.6], peakAt: 0.3, amp: 1.35 })],
  /** Long and falling, with a sad wobble. */
  plaintive: [syl({ dur: 0.95, pitch: [1.25, 1.32, 0.68], open: [0.9, 1.1, 0.5], peakAt: 0.15, vibrato: [4.5, 0.045], amp: 0.85 })],
  /** The "ek-ek-ek" at a bird through the window. */
  chatter: Array.from({ length: 6 }, (_, i) =>
    syl({ at: i * 0.085, dur: 0.055, pitch: [1.5, 1.6, 1.4], open: [1.2, 1.4, 1.1], peakAt: 0.3, amp: 0.75 }),
  ),
  /** A low, closed-mouth complaint. */
  grumble: [syl({ dur: 0.7, pitch: [0.62, 0.72, 0.55], open: [0.45, 0.6, 0.4], peakAt: 0.4, trill: 14, amp: 1.1 })],
  /** A slow, self-satisfied "mrrrraaaow". */
  drawl: [syl({ dur: 1, pitch: [0.8, 1.22, 0.74], open: [0.5, 1.35, 0.55], peakAt: 0.62 })],
  /** Meow, meow, MEOW: getting louder each time. */
  hungry: [0, 1, 2].map((i) =>
    syl({ at: i * 0.36, dur: 0.3, pitch: [1, 1.38 + i * 0.06, 0.85], open: [0.7, 1.35, 0.6], amp: 0.75 + i * 0.25 }),
  ),
  /** Mouth open, almost nothing comes out. */
  silent: [syl({ dur: 0.45, pitch: [1, 1.3, 0.9], open: [0.8, 1.4, 0.7], whisper: true, amp: 0.7 })],
  /** A long, level hum that opens into a meow. */
  om: [syl({ dur: 1.2, pitch: [0.85, 0.9, 0.96], open: [0.35, 0.45, 1.15], peakAt: 0.7, vibrato: [3, 0.012], amp: 0.8 })],
};

export interface MeowOptions {
  /** Multiplies the voice pitch: heavier cats meow lower. */
  pitch?: number;
  /** Stretches the phrase in time. */
  slow?: number;
  /** Not feeling well: quieter, shakier, rougher. */
  weak?: boolean;
  /** A big, lazy wobble in the pitch, as after a few drinks. */
  slur?: number;
}

/** Plays `phrase` in `voice` on `ctx` now. `noise` is a buffer of white noise. */
export function playMeow(ctx: AudioContext, noise: AudioBuffer, voice: MeowVoice, phrase: MeowPhrase, opts: MeowOptions = {}): void {
  const now = ctx.currentTime;
  const slow = opts.slow ?? 1;
  const weak = opts.weak ?? false;
  const pitch = voice.pitch * (opts.pitch ?? 1) * (weak ? 0.92 : 1);
  const rasp = Math.min(1, (voice.rasp ?? 0) + (weak ? 0.3 : 0));
  const loud = (voice.loud ?? 1) * (weak ? 0.6 : 1) * 0.24;

  // Shared tail: everything goes through here, then the echo if any.
  const out = ctx.createGain();
  const loose: AudioNode[] = [out];
  let tail: AudioNode = out;
  if (voice.muffled) {
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 950;
    tail = tail.connect(low);
    loose.push(low);
  }
  tail.connect(ctx.destination);
  if (voice.echo) {
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.19;
    const feedback = ctx.createGain();
    feedback.gain.value = voice.echo;
    echo.connect(feedback).connect(echo);
    tail.connect(echo).connect(ctx.destination);
    loose.push(echo, feedback);
  }

  let end = now;
  for (const s of MEOW_PHRASES[phrase]) {
    const start = now + s.at * slow;
    const dur = s.dur * slow;
    const peak = start + dur * s.peakAt;
    const stop = start + dur;
    end = Math.max(end, stop);
    const nodes: AudioScheduledSourceNode[] = [];

    // The mouth: a formant that opens and closes over the syllable.
    const mouth = ctx.createBiquadFilter();
    mouth.type = "bandpass";
    mouth.Q.value = voice.q;
    mouth.frequency.setValueAtTime(voice.formant * s.open[0], start);
    mouth.frequency.linearRampToValueAtTime(voice.formant * s.open[1], peak);
    mouth.frequency.exponentialRampToValueAtTime(voice.formant * s.open[2], stop);
    let throat: AudioNode = mouth;
    if (voice.nasal) {
      const nose = ctx.createBiquadFilter();
      nose.type = "peaking";
      nose.frequency.value = 2700;
      nose.Q.value = 4;
      nose.gain.value = voice.nasal * 14;
      throat = throat.connect(nose);
    }

    // Loudness envelope, with the trill, growl and stutter riding on it.
    const env = ctx.createGain();
    const amp = loud * (s.amp ?? 1);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(amp, start + Math.min(0.05, dur * 0.3));
    env.gain.setValueAtTime(amp, start + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, stop);
    const flutter = (rate: number, depth: number, type: OscillatorType = "sine") => {
      const lfo = ctx.createOscillator();
      lfo.type = type;
      lfo.frequency.value = rate;
      const d = ctx.createGain();
      d.gain.value = amp * depth;
      lfo.connect(d).connect(env.gain);
      nodes.push(lfo);
    };
    if (s.trill) flutter(s.trill, 0.85);
    if (voice.growl) flutter(32, voice.growl);
    if (voice.stutter) flutter(voice.stutter, 1, "square");
    throat.connect(env).connect(out);

    // The voiced tone, unless it is a whisper.
    if (!s.whisper) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(pitch * s.pitch[0], start);
      osc.frequency.linearRampToValueAtTime(pitch * s.pitch[1], peak);
      osc.frequency.exponentialRampToValueAtTime(pitch * s.pitch[2], stop);
      const wobble = (rate: number, depth: number) => {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rate;
        const d = ctx.createGain();
        d.gain.value = pitch * depth;
        lfo.connect(d).connect(osc.frequency);
        nodes.push(lfo);
      };
      if (s.vibrato) wobble(s.vibrato[0], s.vibrato[1]);
      if (weak) wobble(9, 0.035);
      if (opts.slur) wobble(2.5, opts.slur);
      const voiced = ctx.createGain();
      voiced.gain.value = 1 - rasp * 0.5;
      osc.connect(voiced).connect(mouth);
      nodes.push(osc);
    }

    // Breath: all of a whisper, some of a raspy voice.
    const breath = s.whisper ? 1.6 : rasp;
    if (breath > 0) {
      const air = ctx.createBufferSource();
      air.buffer = noise;
      air.loop = true;
      const g = ctx.createGain();
      g.gain.value = breath * 0.9;
      air.connect(g).connect(mouth);
      nodes.push(air);
    }

    for (const n of nodes) {
      n.start(start);
      n.stop(stop + 0.05);
    }
  }
  // Let the echo ring out, then free the tail: a feedback loop would otherwise keep it alive.
  setTimeout(() => loose.forEach((n) => n.disconnect()), (end - now + 1.5) * 1000);
}
