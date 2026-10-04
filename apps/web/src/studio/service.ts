import type { RatAdoption } from "@dno/chain-adapter";
import { studio } from "@dno/game-spec";
import { buildRatSpec, renderRatSvg } from "@dno/generator";

export type JobKind = "sketch" | "model";
/** `failed` gave its unit back; `rejected` kept it (refused by the safety checker, or past the day's refunds). */
export type JobStatus = "running" | "done" | "failed" | "rejected";

/** One call to an AI service, as the API keeps it. */
export interface StudioJob {
  id: string;
  kind: JobKind;
  status: JobStatus;
  prompt: string;
  /** For a model: the sketch it was made from. */
  sketchId: string | null;
  imageUrl: string | null;
  /** A GLB, served by the API with CORS. */
  modelUrl: string | null;
  error: string | null;
  createdAt: number;
  /** Demo only: the procedural rat standing in for the AI's work. */
  seed?: string;
}

export interface StudioPackInfo {
  id: number;
  key: string;
  name: string;
  priceUsdc: string;
  sketches: number;
  models: number;
}

export interface StudioInfo {
  enabled: boolean;
  /** "off": switched off on this server; "budget": the day's spending cap is reached. */
  paused: null | "off" | "budget";
  packs: StudioPackInfo[];
  /** Null when every account may generate; false when this one is not on the list. */
  allowlisted: boolean | null;
  block: number | null;
}

export interface UnitCount {
  bought: number;
  used: number;
  left: number;
}

export interface StudioCredits {
  sketches: UnitCount;
  models: UnitCount;
  block: number | null;
}

export type StudioErrorCode =
  | "bad-prompt"
  | "refused-prompt"
  | "not-allowlisted"
  | "no-credits"
  | "studio-paused"
  | "already-adopted"
  | "storage-failed"
  | "adopt-unavailable"
  | "unauthorized"
  | "unreachable";

export class StudioError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the studio page needs from whoever runs the AI: the API, or the demo's stand-in. */
export interface StudioService {
  /** True when nothing real is generated nor paid. */
  readonly demo: boolean;
  info(): Promise<StudioInfo>;
  credits(): Promise<StudioCredits>;
  sketch(prompt: string): Promise<StudioJob>;
  model(sketchId: string): Promise<StudioJob>;
  jobs(): Promise<StudioJob[]>;
  job(id: string): Promise<StudioJob>;
  /** The go-ahead to mint a finished AI rat: its files go to Arweave and the API signs. */
  adopt(jobId: string): Promise<RatAdoption>;
}

const CODES = new Set<StudioErrorCode>([
  "bad-prompt",
  "refused-prompt",
  "not-allowlisted",
  "no-credits",
  "studio-paused",
  "already-adopted",
  "storage-failed",
  "adopt-unavailable",
  "unauthorized",
]);

/** The API's studio routes. Every route but `info` needs a session token from a wallet sign-in. */
export class HttpStudio implements StudioService {
  readonly demo = false;
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly token: () => string | null,
  ) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.token();
    const headers: Record<string, string> = { ...(init.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, headers });
    } catch {
      throw new StudioError("unreachable", "The studio cannot be reached.");
    }
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!res.ok) {
      const code = body?.error && CODES.has(body.error as StudioErrorCode) ? (body.error as StudioErrorCode) : res.status === 401 ? "unauthorized" : "unreachable";
      throw new StudioError(code, body?.message ?? `The studio answered ${res.status}.`);
    }
    return body as T;
  }

  info(): Promise<StudioInfo> {
    return this.call("/v1/studio");
  }

  credits(): Promise<StudioCredits> {
    return this.call("/v1/studio/credits");
  }

  async sketch(prompt: string): Promise<StudioJob> {
    return (await this.call<{ job: StudioJob }>("/v1/studio/sketches", { method: "POST", body: JSON.stringify({ prompt }) })).job;
  }

  async model(sketchId: string): Promise<StudioJob> {
    return (await this.call<{ job: StudioJob }>("/v1/studio/models", { method: "POST", body: JSON.stringify({ sketchId }) })).job;
  }

  async jobs(): Promise<StudioJob[]> {
    return (await this.call<{ jobs: StudioJob[] }>("/v1/studio/jobs")).jobs;
  }

  async job(id: string): Promise<StudioJob> {
    return (await this.call<{ job: StudioJob }>(`/v1/studio/jobs/${encodeURIComponent(id)}`)).job;
  }

  adopt(jobId: string): Promise<RatAdoption> {
    return this.call(`/v1/studio/jobs/${encodeURIComponent(jobId)}/adopt`, { method: "POST", body: "{}" });
  }
}

/** The demo's AI rats are procedural rats in disguise: the record names the seed to draw. */
export const DEMO_RAT_URI = "demo-seed:";

/** A few names the demo refuses, to show what a refused prompt looks like. The API has the real list. */
const DEMO_REFUSED = /\b(pikachu|garfield|hello\s*kitty|doraemon|nsfw|nude)\b/i;

/** A fresh 64-bit seed: a rat nobody drew before. */
export function randomSeed(): bigint {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return (BigInt(words[0]!) << 32n) | BigInt(words[1]!);
}

/** Where the demo keeps its jobs, so a reload finds a running one still running. */
const DEMO_KEY = "dno.studio.demo";

interface DemoJob extends StudioJob {
  /** When the stand-in finishes, in ms. */
  doneAt: number;
}

interface DemoState {
  list: DemoJob[];
  used: { sketches: number; models: number };
  next: number;
}

/** How long the demo pretends each kind of job takes, in ms: long enough to watch the wheel. */
export const DEMO_DELAY_MS: Record<JobKind, number> = { sketch: 6000, model: 14000 };

/**
 * The demo's studio: no AI, no API. A "sketch" is the generator's drawing of a random rat and a
 * "model" the same rat in 3D, after a short wait, so the whole flow can be tried without keys.
 * Units come from packs bought with the mock's USDC (`bought`). Jobs are kept in the browser.
 */
export class LocalStudio implements StudioService {
  readonly demo = true;
  private state: DemoState;

  constructor(
    private readonly bought: () => { sketches: number; models: number },
    private readonly delayMs: Record<JobKind, number> = DEMO_DELAY_MS,
  ) {
    this.state = LocalStudio.load();
  }

  private static load(): DemoState {
    try {
      const s = JSON.parse(window.localStorage.getItem(DEMO_KEY) ?? "null") as DemoState | null;
      if (s && Array.isArray(s.list)) return s;
    } catch {
      // Blocked or broken storage: start afresh.
    }
    return { list: [], used: { sketches: 0, models: 0 }, next: 1 };
  }

  private save(): void {
    try {
      window.localStorage.setItem(DEMO_KEY, JSON.stringify(this.state));
    } catch {
      // The jobs then last as long as the page.
    }
  }

  /** Finishes every job whose time is up. */
  private settle(): void {
    const now = Date.now();
    let changed = false;
    for (const job of this.state.list) {
      if (job.status !== "running" || job.doneAt > now) continue;
      job.status = "done";
      job.imageUrl =
        job.kind === "sketch"
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderRatSvg(buildRatSpec(BigInt(job.seed!))))}`
          : (this.state.list.find((j) => j.id === job.sketchId)?.imageUrl ?? null);
      changed = true;
    }
    if (changed) this.save();
  }

  private view(job: DemoJob): StudioJob {
    const { doneAt: _, ...rest } = job;
    return rest;
  }

  async info(): Promise<StudioInfo> {
    return { enabled: true, paused: null, packs: studio.packs.map((p) => ({ ...p })), allowlisted: null, block: null };
  }

  async credits(): Promise<StudioCredits> {
    const b = this.bought();
    const count = (bought: number, used: number): UnitCount => ({ bought, used, left: Math.max(0, bought - used) });
    return { sketches: count(b.sketches, this.state.used.sketches), models: count(b.models, this.state.used.models), block: null };
  }

  async sketch(prompt: string): Promise<StudioJob> {
    const words = prompt.trim();
    if (words.length < studio.prompt.minLength || words.length > studio.prompt.maxLength) throw new StudioError("bad-prompt", "Prompt length out of bounds.");
    if (DEMO_REFUSED.test(words)) throw new StudioError("refused-prompt", "Refused prompt.");
    const credits = await this.credits();
    if (credits.sketches.left < 1) throw new StudioError("no-credits", "No sketch left.");
    this.state.used.sketches++;
    return this.start({ kind: "sketch", prompt: words, sketchId: null, seed: randomSeed().toString() });
  }

  async model(sketchId: string): Promise<StudioJob> {
    this.settle();
    const sketch = this.state.list.find((j) => j.id === sketchId && j.kind === "sketch" && j.status === "done");
    if (!sketch) throw new StudioError("bad-prompt", "Unknown sketch.");
    const credits = await this.credits();
    if (credits.models.left < 1) throw new StudioError("no-credits", "No model left.");
    this.state.used.models++;
    return this.start({ kind: "model", prompt: sketch.prompt, sketchId, seed: sketch.seed });
  }

  async jobs(): Promise<StudioJob[]> {
    this.settle();
    return this.state.list.map((j) => this.view(j)).reverse();
  }

  async job(id: string): Promise<StudioJob> {
    this.settle();
    const job = this.state.list.find((j) => j.id === id);
    if (!job) throw new StudioError("unreachable", "Unknown job.");
    return this.view(job);
  }

  async adopt(jobId: string): Promise<RatAdoption> {
    this.settle();
    const job = this.state.list.find((j) => j.id === jobId && j.kind === "model" && j.status === "done");
    if (!job) throw new StudioError("adopt-unavailable", "Unknown model.");
    return { job: job.id, uri: `${DEMO_RAT_URI}${job.seed}`, deadline: Math.floor(Date.now() / 1000) + 600, signature: "0x", priceUsdc: studio.rats.mint.modelPriceUsdc };
  }

  private start(fields: Pick<StudioJob, "kind" | "prompt" | "sketchId" | "seed">): StudioJob {
    const now = Date.now();
    const job: DemoJob = { id: `demo-${this.state.next++}`, status: "running", imageUrl: null, modelUrl: null, error: null, createdAt: Math.floor(now / 1000), doneAt: now + this.delayMs[fields.kind], ...fields };
    this.state.list.push(job);
    this.save();
    return this.view(job);
  }
}
