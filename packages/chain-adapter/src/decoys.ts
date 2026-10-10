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

/**
 * `decoys` sends that move nothing: a deposit's, which has no real one. Each goes to a wallet
 * of `crowd` (wallets that use the vault, picked at random, none twice), and, when the crowd
 * runs short, to a fresh random address. A wallet that acts on the vault could be the box's
 * holder; a fresh address, which never acts, fools nobody for long.
 */
export function decoySends(decoys: number, crowd: readonly Address[] = []): Send[] {
  const count = Math.max(0, Math.min(MAX_DECOYS, Math.floor(decoys)));
  const pool = [...new Set(crowd.map((a) => a.toLowerCase() as Address))];
  const sends: Send[] = [];
  while (sends.length < count && pool.length) sends.push({ to: pool.splice(randomBelow(pool.length), 1)[0]!, really: false });
  while (sends.length < count) sends.push({ to: randomAddress(), really: false });
  return sends;
}

function randomAddress(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function randomBelow(n: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % n;
}
