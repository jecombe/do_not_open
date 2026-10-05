import { DEMO_DELAY_MS, type JobKind, type StudioJob } from "./service";

/**
 * About how long the AI takes, in seconds: a picture is a few seconds of queue and drawing; a 3D
 * model is the cut-out, then the mesh and the paint on its hidden sides. Only for the progress
 * bar: the services tell nothing of how far along they are.
 */
const EXPECTED_S: Record<JobKind, number> = { sketch: 15, model: 150 };

export function expectedSeconds(kind: JobKind, demo: boolean): number {
  return demo ? DEMO_DELAY_MS[kind] / 1000 : EXPECTED_S[kind];
}

/**
 * When a job started, in ms on this browser's clock: when this page started it if it did, else
 * the API's own date for it (seconds), never in the future of this clock.
 */
export function startedMs(job: StudioJob, startedHere: ReadonlyMap<string, number>, now: number): number {
  return Math.min(startedHere.get(job.id) ?? job.createdAt * 1000, now);
}

/**
 * How far along a running job looks, from 0 to 0.99: brisk at first, then slowing as it nears
 * the end, so a slow service never shows a full bar that does not finish.
 */
export function progressOf(elapsedS: number, expectedS: number): number {
  return Math.min(0.99, 1 - Math.exp((-2.3 * Math.max(0, elapsedS)) / expectedS));
}

/** The same rat runs in the wheel for a job each time it is looked at. */
export function seedOf(id: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < id.length; i++) h = ((h ^ BigInt(id.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h;
}
