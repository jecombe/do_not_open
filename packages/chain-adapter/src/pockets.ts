/** Decoys a pocket action names when the caller says nothing. */
export const DEFAULT_POCKET_DECOYS = 2;

/**
 * The set of pockets an action names: `real`, and up to `decoys` others picked at random among
 * the `count` pockets opened, minus `avoid`, in increasing order as the contract wants them.
 */
export function pocketSet(real: number, count: number, decoys: number, maxSet: number, avoid: number[] = [], random: () => number = Math.random): number[] {
  const pool = Array.from({ length: count }, (_, i) => i).filter((i) => i !== real && !avoid.includes(i));
  const want = Math.max(0, Math.min(decoys, maxSet - 1, pool.length));
  const picked = new Set<number>([real]);
  while (picked.size < want + 1) picked.add(pool[Math.floor(random() * pool.length)]!);
  return [...picked].sort((a, b) => a - b);
}
