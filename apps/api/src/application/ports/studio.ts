import type { StudioJob, StudioJobStatus, StudioLedger, StudioUnits } from "../../domain/studio";
import type { Address } from "../../domain/types";

/**
 * Thrown by a generator when the service ran but refused its own result (a picture its safety
 * checker flagged): the collection was billed, so the unit is not given back.
 */
export class StudioRejected extends Error {}

/** Draws one cartoon picture from a prompt already wrapped in the house style. */
export interface ImageGenerator {
  sketch(styledPrompt: string): Promise<{ url: string }>;
}

/** Turns a picture into a 3D mesh (GLB). */
export interface ModelGenerator {
  model(imageUrl: string): Promise<{ url: string }>;
}

/**
 * The studio's books. Units bought are a read model (a fold of `PackBought`, rebuilt by a replay);
 * jobs are not on the chain, and a replay keeps them.
 */
export interface StudioStore {
  /** Units ever bought for this account. */
  studioUnitsBought(account: Address): Promise<StudioUnits>;
  /**
   * Hands `decide` the account's ledger, locked against every other start, and saves the job it
   * returns, or nothing when it returns null. Two starts never both spend the last unit, nor both
   * take the last dollars of the day's budget. `since` is when the budget's day began.
   */
  startStudioJob(account: Address, since: number, decide: (ledger: StudioLedger) => StudioJob | null): Promise<StudioJob | null>;
  /** Settles a running job; a job already settled is left as it is. */
  finishStudioJob(id: string, result: { status: Exclude<StudioJobStatus, "running">; resultUrl: string | null; error: string | null }, at: number): Promise<void>;
  /** Fails every job still running that was created before `before`: its service call was lost. */
  failStaleStudioJobs(before: number, error: string, at: number): Promise<number>;
  studioJob(id: string): Promise<StudioJob | null>;
  /** The account's jobs, newest first. */
  studioJobs(account: Address, limit: number): Promise<StudioJob[]>;
  /** Units held by the account's running and finished jobs. */
  studioUnitsUsed(account: Address): Promise<StudioUnits>;
  /** Dollars of every job created since `since`, failed ones included, every account together. */
  studioSpentSince(since: number): Promise<number>;
  /** How many of the account's jobs created since `since` failed and gave their unit back. */
  studioRefundsSince(account: Address, since: number): Promise<number>;
  /** Packs sold and the USDC they brought in (whole USDC), every account together. For the metrics. */
  studioSales(): Promise<{ packs: number; paidUsdc: number }>;
  /** Jobs by kind and status, for the metrics. */
  studioJobCounts(): Promise<{ kind: string; status: string; count: number }[]>;
}
