import { createHash } from "node:crypto";
import type { Logger } from "./ports/logger";
import type { ArchiveStore, PermanentStorage } from "./ports/archive";
import type { ReadStore } from "./ports/store";
import { catImageKey, imageOf, sealedImageOf } from "./metadata";

const SVG = "image/svg+xml";

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Where a token image lives for good, once it was stored there. */
export class ImageArchive {
  constructor(
    private readonly store: ArchiveStore,
    /** e.g. https://arweave.net: the stored id is appended. */
    private readonly gateway: string,
  ) {}

  /** The permanent link of this image, or null while it is only served by the API. */
  async urlOf(svg: string): Promise<string | null> {
    const hash = sha256Hex(svg);
    const id = (await this.store.archivedImages([hash])).get(hash);
    return id ? `${this.gateway}/${id}` : null;
  }
}

export interface ArchivePassResult {
  archived: number;
  /** Images over the free size, left on the API. */
  tooLarge: number;
}

/**
 * Stores the token images on Arweave, a few each pass: first the cats opened since the last
 * pass (and any whose picture changed, after a weigh-in), then the sealed boxes in token order.
 * Everything it stores is public already: a sealed box is drawn from its token id, a cat from
 * the seed its opening published.
 */
export class ArchiveImages {
  /** The next sealed box to look at: a box's picture depends on its id only, so it is done once. */
  private nextSealed = 0;
  /** Each opened cat's last picture key that is stored (or too large), to skip it next pass. */
  private readonly catsDone = new Map<number, string>();

  constructor(
    private readonly reads: Pick<ReadStore, "openedBoxes" | "tokenCount">,
    private readonly store: ArchiveStore,
    private readonly storage: PermanentStorage,
    private readonly perPass: number,
    private readonly log: Logger,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async run(): Promise<ArchivePassResult> {
    const result: ArchivePassResult = { archived: 0, tooLarge: 0 };
    let budget = this.perPass;

    const cats = (await this.reads.openedBoxes()).filter((b) => this.catsDone.get(b.tokenId) !== catImageKey(b));
    for (const box of cats) {
      if (budget <= 0) return result;
      budget -= await this.archive(imageOf(box), `cat ${box.tokenId}`, result);
      this.catsDone.set(box.tokenId, catImageKey(box));
    }

    const minted = await this.reads.tokenCount();
    while (budget > 0 && this.nextSealed < minted) {
      budget -= await this.archive(sealedImageOf(this.nextSealed), `box ${this.nextSealed}`, result);
      this.nextSealed++;
    }
    return result;
  }

  /** Returns 1 when it spent an upload, 0 when the image was already stored or too large. */
  private async archive(svg: string, label: string, result: ArchivePassResult): Promise<number> {
    const hash = sha256Hex(svg);
    if ((await this.store.archivedImages([hash])).has(hash)) return 0;
    const bytes = new TextEncoder().encode(svg);
    if (bytes.length > this.storage.maxBytes) {
      result.tooLarge++;
      this.log.warn({ label, bytes: bytes.length }, "image over the free upload size: left on the API");
      return 0;
    }
    const id = await this.storage.put(bytes, SVG);
    await this.store.saveArchivedImage(hash, id, this.now());
    result.archived++;
    this.log.info({ label, id }, "image stored on Arweave");
    return 1;
  }
}
