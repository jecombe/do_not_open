import { MAX_DECOYS, type Address } from "./types";

export interface Send {
  to: Address;
  /** False for a decoy: the transfer moves nothing. */
  really: boolean;
}

/**
 * The transfers that send a box to `to` along with `decoys` decoys, in a random order: each
 * decoy goes to a fresh random address nobody holds the key of. Web Crypto, in browsers and
 * Node alike.
 */
export function decoyPlan(to: Address, decoys: number): Send[] {
  const count = Math.max(0, Math.min(MAX_DECOYS, Math.floor(decoys)));
  const plan: Send[] = [{ to, really: true }];
  for (let i = 0; i < count; i++) plan.push({ to: randomAddress(), really: false });
  // Fisher-Yates, so the real one is not always first.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [plan[i], plan[j]] = [plan[j]!, plan[i]!];
  }
  return plan;
}

function randomAddress(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function randomBelow(n: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % n;
}
