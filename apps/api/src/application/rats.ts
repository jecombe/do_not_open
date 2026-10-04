import { studio as defaultSpec, type StudioSpec } from "@dno/game-spec";
import { buildRatSpec, renderRatSvg } from "@dno/generator";
import type { Adoption, Rat } from "../domain/rats";
import type { Address } from "../domain/types";
import type { Clock } from "./auth";
import type { PermanentStorage } from "./ports/archive";
import type { Logger } from "./ports/logger";
import type { AdoptionSigner, ImageShrinker, RatStore, ServiceFiles } from "./ports/rats";
import type { StudioStore } from "./ports/studio";
import { NotFound } from "./queries";

export type RatRefusal = "not-found" | "not-adoptable" | "already-adopted" | "sold-out" | "wallet-limit" | "storage-failed" | "adopt-unavailable";

/** How many rats were minted, per kind, out of the most there will ever be. */
export interface RatSupplyView {
  seed: { minted: number; max: number };
  model: { minted: number; max: number };
  perWallet: number;
}

/** An adoption turned away before anything was minted: no money moved. */
export class RatRefused extends Error {
  constructor(
    readonly code: RatRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** What the app and the marketplaces see of a rat. */
export interface RatView {
  id: number;
  kind: "seed" | "model";
  seed: string | null;
  job: string | null;
  uri: string | null;
  owner: Address;
  minter: Address;
  mintedBlock: number;
  imageUrl: string;
  modelUrl: string | null;
  /** Paid shakes by the rat's owner. */
  sniffs: number;
}

/** What `mintModel` takes, signed by the attester. */
export interface AdoptionTicket {
  job: string;
  uri: string;
  deadline: number;
  signature: string;
  priceUsdc: string;
}

export interface RatsConfig {
  /** Where this API is reached from outside: seed rats' pictures are served by it. */
  publicUrl: string;
  /** Where Arweave ids are read back, the id appended. */
  gateway: string;
  /** The site's studio, for the metadata's external_url. */
  studioUrl: string | null;
  /** How long an adoption signature stays good. Seconds. */
  ticketTtl: number;
  /** Largest picture and mesh fetched from the service. */
  maxImageBytes: number;
  maxModelBytes: number;
}

/**
 * The depot's rats: read back from the index, described for marketplaces, and adopted. A seed rat
 * needs nothing from here to be minted; an AI rat needs its picture on Arweave (shrunk to a free
 * upload, like a cat's), its 3D model kept here, and the attester's signature, which this hands
 * out to the job's own account only.
 */
export class Rats {
  constructor(
    private readonly rats: RatStore,
    private readonly jobs: Pick<StudioStore, "studioJob">,
    private readonly storage: PermanentStorage | null,
    private readonly files: ServiceFiles,
    private readonly shrinker: ImageShrinker,
    private readonly signer: AdoptionSigner | null,
    private readonly clock: Clock,
    private readonly cfg: RatsConfig,
    private readonly log: Logger,
    private readonly spec: StudioSpec = defaultSpec,
  ) {}

  async list(owner: Address): Promise<RatView[]> {
    const rats = await this.rats.ratsOf(owner);
    const sniffs = await this.rats.sniffsOf([owner]);
    return Promise.all(rats.map((r) => this.view(r, sniffs.get(owner) ?? 0)));
  }

  async get(id: number): Promise<RatView> {
    const rat = await this.rats.rat(id);
    if (!rat) throw new NotFound(`rat ${id} does not exist`);
    const sniffs = await this.rats.sniffsOf([rat.owner]);
    return this.view(rat, sniffs.get(rat.owner) ?? 0);
  }

  /** Rats minted and the caps, as of the index. The caps are the contract's, set from the spec at deployment. */
  async supply(): Promise<RatSupplyView> {
    const counts = await this.rats.ratCounts();
    const minted = (kind: string) => counts.find((c) => c.kind === kind)?.count ?? 0;
    const m = this.spec.rats.mint;
    return { seed: { minted: minted("seed"), max: m.maxSeedRats }, model: { minted: minted("model"), max: m.maxModelRats }, perWallet: m.maxPerWallet };
  }

  /** ERC-721 metadata. */
  async metadata(id: number): Promise<Record<string, unknown>> {
    const rat = await this.rats.rat(id);
    if (!rat) throw new NotFound(`rat ${id} does not exist`);
    const view = await this.view(rat, 0);
    const base = {
      name: `Rat #${id}`,
      image: view.imageUrl,
      ...(this.cfg.studioUrl ? { external_url: this.cfg.studioUrl } : {}),
    };
    if (rat.kind === "seed") {
      const s = buildRatSpec(BigInt(rat.ref));
      return {
        ...base,
        description: "One of the depot's rats, drawn by DO NOT OPEN's rat generator from its seed and adopted from the studio. The cats stay in their boxes; the rats run free.",
        animation_url: null,
        attributes: [
          { trait_type: "Kind", value: "Seed" },
          { trait_type: "Coat", value: s.coat },
          { trait_type: "Pose", value: s.pose },
          { trait_type: "Face", value: s.face },
          { trait_type: "Eyes", value: s.eyes },
          { trait_type: "Hat", value: s.hat },
          { trait_type: "Prop", value: s.prop },
          { trait_type: "Scarf", value: s.scarf ? "yes" : "no" },
        ],
      };
    }
    const adoption = await this.rats.adoptionOfRef(rat.ref);
    return {
      ...base,
      description: adoption
        ? `One of the depot's rats, drawn by AI in DO NOT OPEN's studio from: "${adoption.prompt}".`
        : "One of the depot's rats, drawn by AI in DO NOT OPEN's studio.",
      // Marketplaces show a GLB here in 3D.
      animation_url: view.modelUrl,
      attributes: [{ trait_type: "Kind", value: "AI" }],
    };
  }

  /** A seed rat's picture, recomputed from its seed. An AI rat's is on Arweave. */
  async svg(id: number): Promise<string> {
    const rat = await this.rats.rat(id);
    if (!rat || rat.kind !== "seed") throw new NotFound(`no generated picture for rat ${id}`);
    return renderRatSvg(buildRatSpec(BigInt(rat.ref)));
  }

  /**
   * What the caller needs to mint the AI rat of their studio job: its picture goes to Arweave and
   * its model to this API's store first (once), then the attester signs for this caller only.
   */
  async adopt(account: Address, jobId: string): Promise<AdoptionTicket> {
    if (!this.signer) throw new RatRefused("adopt-unavailable", "AI rats cannot be adopted on this network yet");
    const job = await this.jobs.studioJob(jobId);
    if (!job || job.account !== account) throw new RatRefused("not-found", "no such job of yours");
    if (job.kind !== "model" || job.status !== "done" || !job.resultUrl || !job.sketchId) {
      throw new RatRefused("not-adoptable", "only a finished 3D model can be adopted");
    }
    const jobRef = this.signer.jobRef(jobId);
    if (await this.rats.ratOfRef(jobRef)) throw new RatRefused("already-adopted", "this rat was adopted already");
    // The contract would refuse these: nothing is put on Arweave for a rat that cannot be minted.
    const supply = await this.supply();
    if (supply.model.minted >= supply.model.max) throw new RatRefused("sold-out", "every AI rat has been adopted");
    if ((await this.rats.ratsMintedBy(account)) >= supply.perWallet) throw new RatRefused("wallet-limit", `an address adopts at most ${supply.perWallet} rats`);

    const adoption = (await this.rats.adoption(jobId)) ?? (await this.archive(account, jobId, jobRef, job.prompt, job.sketchId, job.resultUrl));
    const uri = `ar://${adoption.recordId}`;
    const deadline = this.clock.now() + this.cfg.ticketTtl;
    const signature = await this.signer.sign(account, jobRef, uri, deadline);
    return { job: jobRef, uri, deadline, signature, priceUsdc: this.spec.rats.mint.modelPriceUsdc };
  }

  /** An adopted AI rat's 3D model, served by this API. */
  async model(jobRef: string): Promise<Uint8Array> {
    const glb = /^0x[0-9a-f]{64}$/.test(jobRef) ? await this.rats.ratModel(jobRef) : null;
    if (!glb) throw new NotFound("no such rat model");
    return glb;
  }

  /** Where an AI rat's model is served, by its job's bytes32. */
  modelUrl(jobRef: string): string {
    return `${this.cfg.publicUrl}/rats/models/${jobRef}.glb`;
  }

  /**
   * Like a cat's picture: the sketch, shrunk to fit Arweave's free uploads, goes there for good;
   * the mesh stays with this API (no paid storage); a small record on Arweave points at both.
   */
  private async archive(account: Address, jobId: string, jobRef: string, prompt: string, sketchId: string, modelUrl: string): Promise<Adoption> {
    if (!this.storage) throw new RatRefused("adopt-unavailable", "AI rats cannot be adopted on this network yet: no permanent storage");
    const sketch = await this.jobs.studioJob(sketchId);
    if (!sketch?.resultUrl) throw new RatRefused("not-adoptable", "this model's sketch is gone");
    const storage = this.storage;
    const put = async (bytes: Uint8Array, type: string) => {
      try {
        return await storage.put(bytes, type);
      } catch (error) {
        this.log.warn({ job: jobId, err: error instanceof Error ? error.message : String(error) }, "rat picture could not be stored");
        throw new RatRefused("storage-failed", "the rat's picture could not be stored on Arweave: nothing was minted, try again later");
      }
    };
    const fetchFile = async (url: string, max: number) => {
      try {
        return await this.files.get(url, max);
      } catch (error) {
        this.log.warn({ job: jobId, err: error instanceof Error ? error.message : String(error) }, "rat files could not be read back");
        throw new RatRefused("not-adoptable", "the rat's files could not be read back from the service: draw it again");
      }
    };
    const image = await fetchFile(sketch.resultUrl, this.cfg.maxImageBytes);
    const model = await fetchFile(modelUrl, this.cfg.maxModelBytes);
    let picture: Uint8Array;
    try {
      picture = this.shrinker.shrink(image.bytes, storage.maxBytes);
    } catch (error) {
      this.log.warn({ job: jobId, err: error instanceof Error ? error.message : String(error) }, "rat picture could not be shrunk");
      throw new RatRefused("not-adoptable", "the rat's picture could not be prepared: draw it again");
    }
    await this.rats.saveRatModel(jobRef, model.bytes, this.clock.now());
    const imageId = await put(picture, "image/jpeg");
    const record = new TextEncoder().encode(JSON.stringify({ name: "Rat", prompt, image: `ar://${imageId}`, model: this.modelUrl(jobRef), job: jobId }));
    const recordId = await put(record, "application/json");
    const adoption: Adoption = { jobId, jobRef, account, prompt, imageId, recordId, createdAt: this.clock.now() };
    await this.rats.saveAdoption(adoption);
    return adoption;
  }

  private async view(rat: Rat, sniffs: number): Promise<RatView> {
    const gateway = (id: string) => `${this.cfg.gateway}/${id}`;
    if (rat.kind === "seed") {
      return { ...this.common(rat, sniffs), seed: rat.ref, job: null, imageUrl: `${this.cfg.publicUrl}/rats/${rat.id}/image.svg`, modelUrl: null };
    }
    const adoption = await this.rats.adoptionOfRef(rat.ref);
    const record = rat.uri?.startsWith("ar://") ? rat.uri.slice(5) : null;
    return {
      ...this.common(rat, sniffs),
      seed: null,
      job: rat.ref,
      // Files this API did not store itself are only known through the record.
      imageUrl: adoption ? gateway(adoption.imageId) : record ? gateway(record) : `${this.cfg.publicUrl}/rats/${rat.id}`,
      modelUrl: adoption ? this.modelUrl(rat.ref) : null,
    };
  }

  private common(rat: Rat, sniffs: number) {
    return { id: rat.id, kind: rat.kind, uri: rat.uri, owner: rat.owner, minter: rat.minter, mintedBlock: rat.mintedBlock, sniffs };
  }
}
