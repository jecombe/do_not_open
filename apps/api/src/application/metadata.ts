import { buildBoxSpec, buildCatSpec, renderBoxSvg, renderCatSvg, revealedMetadata, sealedMetadata, type CatSpec, type TokenMetadata } from "@dno/generator";
import type { Box } from "../domain/box";
import type { Queries } from "./queries";

/**
 * Token metadata served live from the index, so a marketplace sees an opening as soon as it is
 * indexed. Same builders as `render:metadata`: a sealed box depends on its token id and public
 * facts only, never on a seed.
 */
export class Metadata {
  constructor(
    private readonly queries: Queries,
    /** Public base URL of this API, for the image links. */
    private readonly publicUrl: string,
  ) {}

  async json(tokenId: number): Promise<TokenMetadata> {
    const box = await this.queries.box(tokenId);
    const image = `${this.publicUrl}/metadata/${tokenId}/image.svg`;
    const facts = { duelsWon: box.wins, vetCertified: box.aliveCheck === "alive", entangledWith: box.partner };
    const cat = catOf(box);
    return cat ? revealedMetadata(tokenId, cat, image, facts) : sealedMetadata(tokenId, image, facts);
  }

  async svg(tokenId: number): Promise<string> {
    const box = await this.queries.box(tokenId);
    const cat = catOf(box);
    return cat ? renderCatSvg(cat) : renderBoxSvg(buildBoxSpec(tokenId));
  }
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
