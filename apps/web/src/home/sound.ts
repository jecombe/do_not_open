import { CartoonMusic, ShakeSound, type ClipFx, type MeowPhrase, type MeowVoice } from "@dno/scene";
import type { CatSpec } from "@dno/generator";

const MUTED_KEY = "dno.muted";

export function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * One synthesiser for the home page and the manual, so the toy and the parade share the
 * mute switch. It only makes a sound after a click: browsers keep audio off until then.
 */
export const pageSound = new ShakeSound();
pageSound.muted = readMuted();

/** The tune behind the home page and the game; the sound switch cuts it with the rest. */
export const music = new CartoonMusic();

/** Turns every sound on or off, the music too, and remembers it for the next visit and the game. */
export function setMuted(muted: boolean): void {
  pageSound.muted = muted;
  if (muted) music.stop();
  else music.start();
  saveMuted(muted);
}

/**
 * Starts the music on the page's first click or key, unless the sound is off: browsers keep
 * audio off until then. Returns the cleanup, which also stops it.
 */
export function startMusicOnFirstGesture(isMuted: () => boolean = () => pageSound.muted): () => void {
  const go = () => {
    if (!isMuted()) music.start();
  };
  window.addEventListener("pointerdown", go, { once: true });
  window.addEventListener("keydown", go, { once: true });
  return () => {
    window.removeEventListener("pointerdown", go);
    window.removeEventListener("keydown", go);
    music.stop();
  };
}

export function saveMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
  } catch {
    // Private window or blocked storage: the switch still works for this visit.
  }
}

/** How much lower a heavier cat meows. */
const BUILD_PITCH: Record<NonNullable<CatSpec["weight"]>["build"], number> = {
  thin: 1.2,
  normal: 1,
  chubby: 0.9,
  fat: 0.8,
  huge: 0.7,
};

/** Each breed has its own throat. */
export const BREED_VOICE: Record<string, MeowVoice> = {
  tabby: { pitch: 520, formant: 1300, q: 3 },
  tuxedo: { pitch: 560, formant: 1500, q: 3.5, nasal: 0.2 },
  orange: { pitch: 470, formant: 1150, q: 2.5, rasp: 0.15, loud: 1.2 },
  calico: { pitch: 610, formant: 1650, q: 3 },
  siamese: { pitch: 640, formant: 1900, q: 6, nasal: 0.8, loud: 1.15 },
  void: { pitch: 380, formant: 900, q: 2.5, growl: 0.12, echo: 0.35 },
  sphynx: { pitch: 560, formant: 1400, q: 2, rasp: 0.45 },
  maineCoon: { pitch: 360, formant: 950, q: 2.2, growl: 0.2, loud: 1.15 },
  loaf: { pitch: 480, formant: 1000, q: 2.5, muffled: true },
  glitch: { pitch: 600, formant: 1500, q: 4, stutter: 18 },
};

/** Each mood picks between two ways of saying it; the seed decides which, so a cat always sounds the same. */
export const MOOD_PHRASES: Record<string, [MeowPhrase, MeowPhrase]> = {
  unbothered: ["miaou", "trill"],
  judging: ["silent", "grumble"],
  zoomies: ["doubleMew", "chatter"],
  hungry: ["hungry", "demand"],
  smug: ["drawl", "question"],
  betrayed: ["plaintive", "yowl"],
  plotting: ["chatter", "grumble"],
  enlightened: ["om", "trill"],
};

/** A number from the seed, steady for one cat. */
function seedHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ------------------------------------------------------------------ recorded voices

/**
 * Real cats, recorded by Joseph Sardin for La Sonothèque (lasonotheque.org), CC0: cut into
 * short clips by scripts kept out of the repo, one loudness for all. Each kind of sound has
 * a few takes; the seed picks one, so a cat always says it the same way.
 */
const CLIPS = {
  meow: ["meow-a", "meow-b", "meow-c", "meow-d", "meow-f", "meow-g", "meow-h"],
  drawl: ["meow-e", "meow-a"],
  soft: ["soft-a", "soft-b", "soft-c", "soft-d", "soft-e"],
  short: ["short-a", "short-b"],
  double: ["double"],
  demand: ["demand"],
  kitten: ["kitten-a", "kitten-b"],
  yowl: ["yowl-a", "yowl-b"],
  growl: ["growl-a", "growl-b"],
  grumble: ["grumble"],
  hiss: ["hiss-a", "hiss-b"],
  purr: ["purr"],
} as const;
type ClipKind = keyof typeof CLIPS;

/** Some kinds are quieter or louder by nature; this evens them out. */
const KIND_GAIN: Partial<Record<ClipKind, number>> = { soft: 1.15, hiss: 0.85, purr: 1.25, drawl: 1 };
/** A drawl takes its time. */
const KIND_RATE: Partial<Record<ClipKind, number>> = { drawl: 0.9 };

const clipUrl = (name: string) => `${import.meta.env.BASE_URL}sounds/cats/${name}.mp3`;

/** Each breed's throat, laid over the recording: pitch, ring, grit, echo. */
export const BREED_TIMBRE: Record<string, ClipFx> = {
  tabby: {},
  tuxedo: { rate: 1.03, peak: { freq: 1500, q: 2, db: 4 } },
  orange: { rate: 0.93, gain: 1.15, rasp: 0.15 },
  calico: { rate: 1.08 },
  siamese: { rate: 1.12, gain: 1.1, peak: { freq: 1900, q: 5, db: 9 } },
  void: { rate: 0.84, echo: 0.3, lowpass: 3500 },
  sphynx: { rasp: 0.4, highpass: 350 },
  maineCoon: { rate: 0.8, gain: 1.15, peak: { freq: 250, q: 0.8, db: 4 } },
  loaf: { rate: 0.95, gain: 1.2, lowpass: 900 },
  glitch: { stutter: 14, peak: { freq: 2500, q: 3, db: 5 } },
};

/** Each mood picks between two kinds of sound; the seed decides which. */
export const MOOD_CLIPS: Record<string, [ClipKind, ClipKind]> = {
  unbothered: ["meow", "soft"],
  judging: ["hiss", "grumble"],
  zoomies: ["double", "short"],
  hungry: ["demand", "meow"],
  smug: ["drawl", "soft"],
  betrayed: ["yowl", "kitten"],
  plotting: ["growl", "soft"],
  enlightened: ["purr", "soft"],
};

const pick = (kind: ClipKind, hash: number) => {
  const takes = CLIPS[kind];
  return takes[hash % takes.length]!;
};

/** A recording, or the synthesised fallback when it cannot be played (sound off, file missing). */
function sayRecorded(sound: ShakeSound, kind: ClipKind, hash: number, fx: ClipFx, fallback: () => void): void {
  const full = { ...fx, gain: (fx.gain ?? 1) * (KIND_GAIN[kind] ?? 1), rate: (fx.rate ?? 1) * (KIND_RATE[kind] ?? 1) };
  void sound.clip(clipUrl(pick(kind, hash)), full).then((played) => {
    if (!played && !sound.muted) fallback();
  });
}

/** A complaint from inside a box being shaken: a real meow, heard through cardboard. */
export function boxComplaint(sound: ShakeSound = pageSound): void {
  const kind: ClipKind = Math.random() < 0.6 ? "soft" : "short";
  sayRecorded(sound, kind, Math.floor(Math.random() * 1000), { lowpass: 750, gain: 0.9, rate: 0.95 + Math.random() * 0.1 }, () => sound.complaint());
}

/** What a cat says when it comes out, or when it is clicked: its breed is the voice, its mood the words. */
export function catVoice(cat: CatSpec, sound: ShakeSound = pageSound): void {
  const hash = seedHash(cat.seed);
  const voice = BREED_VOICE[cat.traits.breed.variant] ?? BREED_VOICE.tabby!;
  const phrase = (MOOD_PHRASES[cat.traits.mood.variant] ?? ["miaou", "miaou"])[hash & 1]!;
  // Two cats of one breed are not twins: up to 8% apart.
  const own = 0.92 + ((hash >>> 1) % 17) / 100;
  const build = cat.weight ? BUILD_PITCH[cat.weight.build] : 1;
  const opts = {
    pitch: own * build,
    slow: cat.vice === "stoned" ? 1.7 : cat.vice === "drunk" ? 1.3 : 1,
    slur: cat.vice === "drunk" ? 0.12 : cat.vice === "stoned" ? 0.04 : 0,
    weak: !!cat.weight?.sick,
  };
  const synth = () => sound.meow(voice, phrase, opts);

  // The recorded voice: the breed's throat, this cat's own pitch, its build, its vice.
  const timbre = BREED_TIMBRE[cat.traits.breed.variant] ?? {};
  // A heavier cat is lower, but less so than the synthesiser makes it: recordings stretch.
  const buildRate = 1 - (1 - build) * 0.6;
  const fx: ClipFx = { ...timbre, rate: (timbre.rate ?? 1) * own * buildRate };
  if (cat.vice === "stoned") {
    fx.rate! *= 0.82;
    fx.lowpass = Math.min(fx.lowpass ?? 20_000, 2500);
  }
  if (cat.vice === "drunk") fx.wobble = 70;
  const kind = (MOOD_CLIPS[cat.traits.mood.variant] ?? ["meow", "meow"])[hash & 1]!;
  const say = (extra: ClipFx = {}, k: ClipKind = kind) => sayRecorded(sound, k, hash >>> 3, { ...fx, ...extra }, synth);

  if (cat.state === "ghost") {
    // A meow played backwards, slowed, far away.
    return sayRecorded(sound, "yowl", hash >>> 3, { reverse: true, rate: 0.75 * own, echo: 0.5, lowpass: 1800, gain: 0.9 }, () => sound.wail());
  }
  if (cat.state === "asleep") return sayRecorded(sound, "purr", 0, { rate: buildRate, gain: 1.1 }, () => sound.purr());
  if (cat.state === "quantum") {
    sound.glitch();
    setTimeout(() => say({ stutter: 16 }), 380);
    return;
  }
  if (cat.weight?.sick) {
    sound.cough();
    setTimeout(() => say({ rate: (fx.rate ?? 1) * 0.9, gain: (fx.gain ?? 1) * 0.7, lowpass: Math.min(fx.lowpass ?? 20_000, 2500) }), 450);
    return;
  }
  say();
}
