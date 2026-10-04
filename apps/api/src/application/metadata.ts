import { buildBoxSpec, buildCatSpec, renderBoxSvg, renderCatSvg, revealedMetadata, sealedMetadata, type CatSpec, type TokenMetadata } from "@dno/generator";
import type { Box } from "../domain/box";
import type { ImageArchive } from "./archive";
import type { Queries } from "./queries";

/**
 * Token metadata served live from the index, so a marketplace sees an opening as soon as it is
 * indexed. Same builders as `render:metadata`: a sealed box depends on its token id and public
 * facts only, never on a seed. The image links to Arweave once `ArchiveImages` stored it there,
 * and to this API until then.
 */
export class Metadata {
  constructor(
    private readonly queries: Queries,
    /** Public base URL of this API, for the image links. */
    private readonly publicUrl: string,
    private readonly archive: ImageArchive | null = null,
  ) {}

  async json(tokenId: number): Promise<TokenMetadata> {
    const box = await this.queries.box(tokenId);
    const cat = catOf(box);
    const svg = cat ? renderCatSvg(cat) : sealedImageOf(tokenId);
    const image = (await this.archive?.urlOf(svg)) ?? `${this.publicUrl}/metadata/${tokenId}/image.svg`;
    const facts = { duelsWon: box.wins, vetCertified: box.aliveCheck === "alive", entangledWith: box.partner };
    return cat ? revealedMetadata(tokenId, cat, image, facts) : sealedMetadata(tokenId, image, facts);
  }

  async svg(tokenId: number): Promise<string> {
    return imageOf(await this.queries.box(tokenId));
  }
}

/** The token's picture: its cat once opened, its sealed box before. */
export function imageOf(box: Box): string {
  const cat = catOf(box);
  return cat ? renderCatSvg(cat) : sealedImageOf(box.tokenId);
}

/** A sealed box's picture, drawn from its token id alone. */
export function sealedImageOf(tokenId: number): string {
  return renderBoxSvg(buildBoxSpec(tokenId));
}

/** What an opened cat's picture is drawn from: it changes when one of these does. */
export function catImageKey(box: Box): string {
  return JSON.stringify([box.revealed, box.weighIn]);
}

function catOf(box: Box): CatSpec | null {
  if (!box.revealed) return null;
  const w = box.weighIn;
  return buildCatSpec({
    seed: BigInt(box.revealed.seed),
    affection: box.revealed.affection,
    weighIn: w ? { weight: BigInt(w.weight), sick: w.sick, disease: w.disease } : undefined,
  });
}
