import { ShakeSound } from "@dno/scene";
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

/** What a cat says when it comes out, or when it is clicked. */
export function catVoice(cat: CatSpec, sound: ShakeSound = pageSound): void {
  if (cat.state === "ghost") return sound.wail();
  if (cat.state === "asleep") return sound.purr();
  if (cat.state === "quantum") {
    sound.glitch();
    return sound.meow(1.1);
  }
  const pitch = cat.weight ? BUILD_PITCH[cat.weight.build] : 1;
  if (cat.weight?.sick) {
    sound.cough();
    setTimeout(() => sound.meow(pitch, true), 450);
    return;
  }
  sound.meow(pitch);
}
