/** `PocketSavings.Side`: Save puts cUSDC into shares through the deposit batcher, Unsave brings shares back. */
export type SavingsSide = 0 | 1;
export const SAVINGS_SIDES: readonly SavingsSide[] = [0, 1];

/** `PocketSavings.WindowState`. */
export const WINDOW_OPEN = 0;
export const WINDOW_JOINED = 1;
export const WINDOW_SETTLED = 2;
export const WINDOW_CANCELED = 3;

/** The batcher's `BatchState`: 0 Pending, 1 Dispatched, then one of these. */
export const BATCH_FINALIZED = 2;
export const BATCH_CANCELED = 3;

/** `PocketSavings.windowInfo`, the fields the keeper decides on. */
export interface SavingsWindow {
  side: SavingsSide;
  state: number;
  /** The batch it joined, 0 until then. */
  batchId: number;
  /** Pockets with a commitment in it, decoys included. */
  pocketCount: number;
  /** Pockets not settled yet, once the window is. */
  left: number;
}

/** The batcher's current batch, the one a window joins. */
export interface SavingsBatch {
  id: number;
  /** Unix seconds. */
  createdAt: number;
  /** Seconds after `createdAt` before it can be dispatched; 0 on a test chain. */
  minBatchAge: number;
  /** A paused batcher takes no joins. */
  paused: boolean;
}

/**
 * The savings contract and Zama's two batchers, as the keeper reads and drives them. Writes
 * resolve once the transaction is mined, so a tick sees what the one before did; one that
 * reverts throws with the contract's reason.
 */
export interface SavingsChain {
  windowCount(): Promise<number>;
  openWindow(side: SavingsSide): Promise<number>;
  /** The last batch a window of the side joined: one window per batch. */
  lastBatch(side: SavingsSide): Promise<number>;
  windowInfo(windowId: number): Promise<SavingsWindow>;
  /** The window's pockets still holding a commitment: those `settlePockets` has not reached, in the order they came. */
  unsettledPockets(windowId: number): Promise<number[]>;
  /** The side's batcher's current batch. */
  currentBatch(side: SavingsSide): Promise<SavingsBatch>;
  batchState(side: SavingsSide, batchId: number): Promise<number>;
  /** Joins the side's open window to the batcher's current batch. Returns the transaction hash. */
  join(side: SavingsSide): Promise<string>;
  /** Claims (or recovers) what the window's batch gave, once the batch is finalized or canceled. */
  settle(windowId: number): Promise<string>;
  /** Gives each of `ids` its part of a settled window. */
  settlePockets(windowId: number, ids: number[]): Promise<string>;
}
