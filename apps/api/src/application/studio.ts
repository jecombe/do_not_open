import { studio as defaultSpec, styledPrompt, type StudioSpec } from "@dno/game-spec";
import { dayStart, refusedWord, unitOf, unitsLeft, type StudioJob, type StudioKind, type StudioLedger, type StudioUnits } from "../domain/studio";
import type { Address } from "../domain/types";
import type { Clock } from "./auth";
import type { Logger } from "./ports/logger";
import { StudioRejected, type ImageGenerator, type ModelGenerator, type StudioStore } from "./ports/studio";

export type StudioRefusal = "bad-prompt" | "refused-prompt" | "not-allowlisted" | "no-credits" | "studio-paused" | "not-found";
export type StudioPause = "off" | "budget";

/** A generation the studio turned away before any service was called, so it cost nothing. */
export class StudioRefused extends Error {
  constructor(
    readonly code: StudioRefusal,
    message: string,
    /** For `studio-paused`: why. */
    readonly reason: StudioPause | "disabled" | null = null,
  ) {
    super(message);
  }
}

export interface StudioConfig {
  /** False when the services' key or the StudioPacks contract is missing: nothing can be generated. */
  enabled: boolean;
  /** A kill switch: the studio sells nothing more until it is turned back on. */
  paused: boolean;
  /** Dollars the studio may spend on the services per UTC day, every account together. */
  dailyBudgetUsd: number;
  /** When set, only these (lowercase) addresses may generate: for a test network, where packs are paid in test USDC. */
  allowlist: Set<string> | null;
  /** A running job older than this is taken as lost and its unit given back. Seconds. */
  staleAfter: number;
  /**
   * Failed jobs an account gets its unit back for per UTC day. Past it a failure keeps its unit:
   * the service may have billed it, and endless failures on one unit would bill the collection
   * without limit.
   */
  refundsPerDay: number;
  newId: () => string;
}

export interface StudioInfo {
  enabled: boolean;
  paused: StudioPause | null;
  packs: { id: number; key: string; name: string; priceUsdc: string; sketches: number; models: number }[];
  allowlisted: boolean | null;
}

export interface StudioCredits {
  sketches: { bought: number; used: number; left: number };
  models: { bought: number; used: number; left: number };
}

/**
 * The studio: a cat drawn from a prompt by paid AI services, out of units bought on-chain in
 * StudioPacks. A unit is spent when its job starts, before the service is called, and given back
 * when the service fails or the job is lost. Nothing is ever generated on credit, and the day's
 * spending stops at the budget whatever the units bought.
 */
export class Studio {
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly store: StudioStore,
    private readonly images: ImageGenerator,
    private readonly models: ModelGenerator,
    private readonly clock: Clock,
    private readonly cfg: StudioConfig,
    private readonly log: Logger,
    private readonly spec: StudioSpec = defaultSpec,
  ) {}

  async info(account: Address | null): Promise<StudioInfo> {
    return {
      enabled: this.cfg.enabled,
      paused: this.cfg.enabled ? await this.pause() : null,
      packs: this.spec.packs.map((p) => ({ id: p.id, key: p.key, name: p.name, priceUsdc: p.priceUsdc, sketches: p.sketches, models: p.models })),
      allowlisted: this.cfg.allowlist && account ? this.cfg.allowlist.has(account) : null,
    };
  }

  async credits(account: Address): Promise<StudioCredits> {
    await this.recover();
    const [bought, used] = await Promise.all([this.store.studioUnitsBought(account), this.store.studioUnitsUsed(account)]);
    const left = unitsLeft(bought, used);
    return {
      sketches: { bought: bought.sketches, used: used.sketches, left: left.sketches },
      models: { bought: bought.models, used: used.models, left: left.models },
    };
  }

  /** Draws a cartoon cat from the player's words. Returns at once; the job runs in the background. */
  async sketch(account: Address, rawPrompt: unknown): Promise<StudioJob> {
    const prompt = typeof rawPrompt === "string" ? rawPrompt.trim().replace(/\s+/g, " ") : "";
    const { minLength, maxLength } = this.spec.prompt;
    if (prompt.length < minLength || prompt.length > maxLength) throw new StudioRefused("bad-prompt", `describe the cat in ${minLength} to ${maxLength} characters`);
    const word = refusedWord(prompt);
    if (word) throw new StudioRefused("refused-prompt", `the studio does not draw "${word}": licensed characters, brands and adult or violent content are refused`);
    const job = await this.start(account, "sketch", prompt, null);
    this.run(job, () => this.images.sketch(styledPrompt(prompt, this.spec)));
    return job;
  }

  /** Turns one of the account's finished sketches into a 3D model. */
  async model(account: Address, sketchId: string): Promise<StudioJob> {
    const sketch = await this.store.studioJob(sketchId);
    if (!sketch || sketch.account !== account || sketch.kind !== "sketch") throw new StudioRefused("not-found", "no such sketch of yours");
    if (sketch.status !== "done" || !sketch.resultUrl) throw new StudioRefused("not-found", "this sketch is not finished");
    const job = await this.start(account, "model", sketch.prompt, sketch.id);
    const imageUrl = sketch.resultUrl;
    this.run(job, () => this.models.model(imageUrl));
    return job;
  }

  async jobs(account: Address, limit = 50): Promise<StudioJob[]> {
    await this.recover();
    return this.store.studioJobs(account, Math.min(limit, 50));
  }

  /** One of the account's jobs. */
  async job(account: Address, id: string): Promise<StudioJob> {
    await this.recover();
    const job = await this.store.studioJob(id);
    if (!job || job.account !== account) throw new StudioRefused("not-found", "no such job of yours");
    return job;
  }

  /**
   * Where the service left a finished job's file: its picture (a model's is its sketch's) or its
   * mesh. Null when there is none. Anyone with the job's id may fetch it: ids are random.
   */
  async fileOf(id: string, file: "image" | "model"): Promise<string | null> {
    const job = await this.store.studioJob(id);
    if (!job || job.status !== "done") return null;
    if (file === "model") return job.kind === "model" ? job.resultUrl : null;
    if (job.kind === "sketch") return job.resultUrl;
    return job.sketchId ? ((await this.store.studioJob(job.sketchId))?.resultUrl ?? null) : null;
  }

  /** Fails what a crash left running, so its units come back. Called at start and before reads. */
  async recover(): Promise<number> {
    const now = this.clock.now();
    const n = await this.store.failStaleStudioJobs(now - this.cfg.staleAfter, "the generation was lost; its unit is back", now);
    if (n) this.log.warn({ jobs: n }, "studio jobs lost, units given back");
    return n;
  }

  /** Resolves once every job started so far has settled. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  /** What every job ever cost, in dollars (estimated). */
  spentTotal(): Promise<number> {
    return this.store.studioSpentSince(0);
  }

  /** What the day's jobs cost, in dollars. */
  spentToday(): Promise<number> {
    return this.store.studioSpentSince(dayStart(this.clock.now()));
  }

  private async pause(): Promise<StudioPause | null> {
    if (this.cfg.paused) return "off";
    // A job that would not fit what is left of the budget is refused, so the cheapest one decides.
    const cheapest = Math.min(this.costOf("sketch"), this.costOf("model"));
    return (await this.spentToday()) + cheapest > this.cfg.dailyBudgetUsd ? "budget" : null;
  }

  private costOf(kind: StudioKind): number {
    return Number(this.spec.units[kind].estimatedCostUsd);
  }

  private async start(account: Address, kind: StudioKind, prompt: string, sketchId: string | null): Promise<StudioJob> {
    if (!this.cfg.enabled) throw new StudioRefused("studio-paused", "the studio is not available on this network", "disabled");
    if (this.cfg.paused) throw new StudioRefused("studio-paused", "the studio is closed for now", "off");
    if (this.cfg.allowlist && !this.cfg.allowlist.has(account)) throw new StudioRefused("not-allowlisted", "the studio is open to a list of testers on this network");
    await this.recover();
    const now = this.clock.now();
    const costUsd = this.costOf(kind);
    let refusal: StudioRefused | null = null;
    const job = await this.store.startStudioJob(account, dayStart(now), (ledger: StudioLedger) => {
      if (ledger.spentTodayUsd + costUsd > this.cfg.dailyBudgetUsd) {
        refusal = new StudioRefused("studio-paused", "the studio spent its budget for today; come back tomorrow, your units wait for you", "budget");
        return null;
      }
      const left: StudioUnits = unitsLeft(ledger.bought, ledger.used);
      if (left[unitOf(kind)] < 1) {
        refusal = new StudioRefused("no-credits", `no ${this.spec.units[kind].name.toLowerCase()} left: buy a pack first`);
        return null;
      }
      return { id: this.cfg.newId(), account, kind, status: "running", prompt, sketchId, resultUrl: null, error: null, costUsd, createdAt: now, finishedAt: null };
    });
    if (!job) throw refusal ?? new StudioRefused("no-credits", "no unit left");
    return job;
  }

  /**
   * Calls the service in the background, then settles the job: done with its file; failed with its
   * unit back; or rejected, unit kept, when the service refused its own result or the account
   * already had its refunds of the day.
   */
  private run(job: StudioJob, generate: () => Promise<{ url: string }>): void {
    const task = (async () => {
      try {
        const { url } = await generate();
        await this.store.finishStudioJob(job.id, { status: "done", resultUrl: url, error: null }, this.clock.now());
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        try {
          const refunds = error instanceof StudioRejected ? Infinity : await this.store.studioRefundsSince(job.account, dayStart(this.clock.now()));
          const refund = refunds < this.cfg.refundsPerDay;
          this.log.warn({ job: job.id, kind: job.kind, refund, err: why }, "studio generation failed");
          const settled = refund
            ? { status: "failed" as const, error: "the service could not draw this one; your unit is back" }
            : error instanceof StudioRejected
              ? { status: "rejected" as const, error: "the picture was refused by the safety checker; the unit is spent" }
              : { status: "rejected" as const, error: "the service could not draw this one, and today's refunds are used up; the unit is spent" };
          await this.store.finishStudioJob(job.id, { ...settled, resultUrl: null }, this.clock.now());
        } catch (e) {
          this.log.error({ job: job.id, err: String(e) }, "could not settle a studio job");
        }
      }
    })();
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }
}
