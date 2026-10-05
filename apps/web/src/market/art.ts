import type { BoxInfo, RatInfo } from "@dno/chain-adapter";
import { buildBoxSpec, renderBoxSvg, renderCatSvg } from "@dno/generator";
import { catFromRevealed } from "../chain/copy";
import { thumbOf } from "../views/RatsView";

const uri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// Drawings are pure functions of public facts: each is made once per page.
const drawn = new Map<string, string>();
const once = (key: string, draw: () => string) => {
  let hit = drawn.get(key);
  if (!hit) drawn.set(key, (hit = draw()));
  return hit;
};

/** A sealed box from its token id alone (never its seed), or the cat an opened box showed. */
export function boxArt(tokenId: number, box: BoxInfo | undefined): string {
  if (box?.revealed) {
    const r = box.revealed;
    return once(`cat:${tokenId}:${r.affection}`, () => uri(renderCatSvg(catFromRevealed(r))));
  }
  return once(`box:${tokenId}`, () => uri(renderBoxSvg(buildBoxSpec(tokenId))));
}

export function ratArt(rat: RatInfo | undefined): string | null {
  return rat ? thumbOf(rat) : null;
}
