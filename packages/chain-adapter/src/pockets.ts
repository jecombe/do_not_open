/**
 * A pocket's group: the pockets every one of its actions names, this one included, always the
 * same. Groups are fixed by number, `maxSet` apiece (0 to 4, 5 to 9...), so a set only ever says
 * which group acted, never which pocket, however many actions are compared. Random decoys would
 * not: the real pocket is the one in every set, so two or three sets of the same pocket
 * intersect down to it. The last group holds the pockets opened so far: it fills as pockets open.
 */
export function pocketGroup(real: number, count: number, maxSet: number): number[] {
  const start = Math.floor(real / maxSet) * maxSet;
  const members = Array.from({ length: Math.max(0, Math.min(maxSet, count - start)) }, (_, i) => start + i);
  return members.includes(real) ? members : [...members, real].sort((a, b) => a - b);
}

/**
 * The set an action on `real` names: its whole group, or, when fewer `others` are asked, `real`
 * and the lowest-numbered others of its group, still the same ones every time. In increasing
 * order, as the contract wants a set.
 */
export function pocketSet(real: number, count: number, maxSet: number, others?: number): number[] {
  const group = pocketGroup(real, count, maxSet);
  if (others === undefined || others >= group.length - 1) return group;
  const rest = group.filter((i) => i !== real).slice(0, Math.max(0, Math.floor(others)));
  return [real, ...rest].sort((a, b) => a - b);
}
