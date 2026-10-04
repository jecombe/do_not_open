import { StudioRejected, type ImageGenerator, type ModelGenerator } from "../../application/ports/studio";

export interface FalOptions {
  apiKey: string;
  /** The picture model, e.g. fal-ai/flux/schnell. */
  imageModel: string;
  /** The picture-to-mesh model, e.g. fal-ai/hunyuan3d/v2 or fal-ai/trellis. */
  modelModel: string;
  /**
   * A background remover run on the sketch first, e.g. fal-ai/birefnet, or null to skip it. A
   * picture-to-mesh model takes the whole square for the object otherwise, and builds a card
   * with the drawing on it instead of a rat.
   */
  cutoutModel?: string | null;
  /** How long one generation may take, queue included. */
  timeoutMs: number;
  /** Between two looks at a queued request. */
  pollMs?: number;
  queueUrl?: string;
  fetch?: typeof fetch;
}

interface Queued {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

/**
 * fal.ai's queue over plain HTTP: submit, poll the status until it is done, read the result.
 * The key never leaves the server. One key pays for both services.
 */
export class FalStudio implements ImageGenerator, ModelGenerator {
  private readonly fetchImpl: typeof fetch;
  private readonly queueUrl: string;

  constructor(private readonly opts: FalOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.queueUrl = (opts.queueUrl ?? "https://queue.fal.run").replace(/\/$/, "");
  }

  async sketch(styledPrompt: string): Promise<{ url: string }> {
    const out = await this.generate(this.opts.imageModel, { prompt: styledPrompt, image_size: "square_hd", num_images: 1, enable_safety_checker: true, output_format: "jpeg" });
    const image = (out as { images?: { url?: unknown }[]; has_nsfw_concepts?: unknown[] }).images?.[0];
    const nsfw = (out as { has_nsfw_concepts?: unknown[] }).has_nsfw_concepts?.[0] === true;
    if (nsfw) throw new StudioRejected("the picture was flagged by the safety checker");
    if (typeof image?.url !== "string") throw new Error("fal returned no picture");
    return { url: image.url };
  }

  async model(imageUrl: string): Promise<{ url: string }> {
    let source = imageUrl;
    if (this.opts.cutoutModel) {
      const cut = (await this.generate(this.opts.cutoutModel, { image_url: imageUrl })) as { image?: { url?: unknown } };
      if (typeof cut.image?.url !== "string") throw new Error("fal returned no cut-out picture");
      source = cut.image.url;
    }
    // Hunyuan3D paints the sides the picture does not show; Trellis leaves them black.
    const input = /hunyuan/i.test(this.opts.modelModel) ? { input_image_url: source, textured_mesh: true } : { image_url: source };
    const out = (await this.generate(this.opts.modelModel, input)) as { model_mesh?: { url?: unknown }; model_glb?: { url?: unknown } };
    const url = out.model_mesh?.url ?? out.model_glb?.url;
    if (typeof url !== "string") throw new Error("fal returned no mesh");
    return { url };
  }

  private async generate(model: string, input: object): Promise<unknown> {
    const deadline = Date.now() + this.opts.timeoutMs;
    const queued = (await this.call(`${this.queueUrl}/${model}`, { method: "POST", body: JSON.stringify(input) }, deadline)) as Queued;
    if (!queued.status_url || !queued.response_url) throw new Error("fal did not queue the request");
    for (;;) {
      const status = (await this.call(queued.status_url, { method: "GET" }, deadline)) as { status?: string };
      if (status.status === "COMPLETED") break;
      if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") throw new Error(`fal request ${queued.request_id ?? ""} ended ${status.status ?? "without a status"}`);
      if (Date.now() + (this.opts.pollMs ?? 1500) > deadline) throw new Error("fal took too long");
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1500));
    }
    return this.call(queued.response_url, { method: "GET" }, deadline);
  }

  private async call(url: string, init: { method: string; body?: string }, deadline: number): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { authorization: `Key ${this.opts.apiKey}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`fal answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
}
