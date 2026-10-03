/**
 * Claims name token ids in the clear. A claim listing only the caller's boxes would tell everyone
 * which boxes they hold, though the contracts pay a stranger's claim nothing. So the app claims
 * whole windows of ids instead: ids 0-9, 10-19, and so on, the same window every time, so that
 * claims made over months cannot be intersected down to the boxes inside. Anyone watching learns
 * "maybe one of these ten", no more than a mint of ten ids shows.
 */
export const CLAIM_WINDOW = 10;

/** The windows holding `tokenIds`, each cut at `tokenCount` (ids past it do not exist yet). */
export function claimWindows(tokenIds: number[], tokenCount: number): number[][] {
  const starts = [...new Set(tokenIds.filter((id) => id >= 0 && id < tokenCount).map((id) => id - (id % CLAIM_WINDOW)))].sort((a, b) => a - b);
  return starts.map((start) => {
    const ids: number[] = [];
    for (let id = start; id < Math.min(start + CLAIM_WINDOW, tokenCount); id++) ids.push(id);
    return ids;
  });
}
