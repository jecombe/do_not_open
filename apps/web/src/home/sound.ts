import { ShakeSound, type MeowPhrase, type MeowVoice } from "@dno/scene";
import type { CatSpec } from "@dno/generator";

const MUTED_KEY = "dno.muted";

function readMuted(): boolean {
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

export function setMuted(muted: boolean): void {
  pageSound.muted = muted;
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

/** What a cat says when it comes out, or when it is clicked: its breed is the voice, its mood the words. */
export function catVoice(cat: CatSpec, sound: ShakeSound = pageSound): void {
  if (cat.state === "ghost") return sound.wail();
  if (cat.state === "asleep") return sound.purr();
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
  if (cat.state === "quantum") {
    sound.glitch();
    setTimeout(() => sound.meow(voice, phrase, opts), 380);
    return;
  }
  if (cat.weight?.sick) {
    sound.cough();
    setTimeout(() => sound.meow(voice, phrase, opts), 450);
    return;
  }
  sound.meow(voice, phrase, opts);
}
