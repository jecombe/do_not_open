import type { Logger } from "../application/ports/logger";
import type { SyncChain, SyncResult } from "../application/syncChain";

export interface IndexerOptions {
  /** Wait between passes once caught up: about one block. */
  pollMs: number;
  /** Shortest wait between two passes, however often the app nudges. */
  minGapMs: number;
  /** Longest wait after failures, which grow it from `pollMs`. */
  maxBackoffMs: number;
}

export interface IndexerStatus {
  running: boolean;
  lastPass: SyncResult | null;
  lastPassAt: number | null;
  lastError: string | null;
  failures: number;
}

/**
 * Runs the sync passes: back to back while catching up, once a block when caught up, sooner
 * when the app says a transaction just went through (`nudge`). Nudges arriving together are
 * one pass, and never closer than `minGapMs`: a crowd of clicks cannot flood the RPC.
 */
export class Indexer {
  private running = false;
  private wake: (() => void) | null = null;
  private nudged = false;
  private status_: IndexerStatus = { running: false, lastPass: null, lastPassAt: null, lastError: null, failures: 0 };
  private done: Promise<void> | null = null;

  constructor(
    private readonly sync: Pick<SyncChain, "pass">,
    private readonly opts: IndexerOptions,
    private readonly log: Logger,
    private readonly sleep: (ms: number, wake: (cb: () => void) => void) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  status(): IndexerStatus {
    return { ...this.status_, running: this.running };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.done = this.loop();
  }

  async stop() {
    this.running = false;
    this.wake?.();
    await this.done;
  }

  /** Asks for a pass soon. Cheap, and safe to call on every request that wants one. */
  nudge() {
    this.nudged = true;
    this.wake?.();
  }

  private async loop() {
    let lastPassAt = 0;
    while (this.running) {
      this.nudged = false;
      let wait = this.opts.pollMs;
      try {
        lastPassAt = this.now();
        const r = await this.sync.pass();
        this.status_ = { ...this.status_, lastPass: r ?? this.status_.lastPass, lastPassAt, lastError: null, failures: 0 };
        // Behind: go again straight away.
        if (r && r.to < r.target) wait = 0;
      } catch (error) {
        const failures = this.status_.failures + 1;
        this.status_ = { ...this.status_, lastError: (error as Error).message, failures };
        wait = Math.min(this.opts.maxBackoffMs, this.opts.pollMs * 2 ** Math.min(failures, 6));
        this.log.error({ error: (error as Error).message, failures, retryInMs: wait }, "sync pass failed");
      }
      if (!this.running) break;
      if (wait > 0 && !this.nudged) {
        await this.sleep(wait, (cb) => (this.wake = cb));
        this.wake = null;
      }
      // Woken by a nudge: still keep the minimum gap since the last pass.
      const gap = this.opts.minGapMs - (this.now() - lastPassAt);
      if (this.running && gap > 0) await this.sleep(gap, () => undefined);
    }
  }
}

function defaultSleep(ms: number, onWake: (cb: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    onWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
