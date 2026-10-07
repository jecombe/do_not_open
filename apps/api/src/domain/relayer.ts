/**
 * Metering the relayer. Zama bills the collection for every value it decrypts and every
 * encrypted input it verifies. Each wallet gets a free allowance a day, counted in units: one
 * unit is one value decrypted for that wallet, and an encrypted input costs as many units as
 * Zama charges for it over a decryption (five on its price list, at every plan). Past the
 * allowance, units come out of the credits the wallet bought on-chain, one credit a unit.
 */

/** What a wallet has used: free units today, and credits ever spent. Credits ever bought come from the chain. */
export interface Meter {
  freeUsed: number;
  spent: number;
  bought: number;
}

/** Units taken from the day's free allowance and from credits. Negative to give them back. */
export interface Charge {
  free: number;
  credits: number;
}

export interface Allowance {
  /** Free units a day for this wallet: fewer before its first act on-chain. */
  freePerDay: number;
  freeLeft: number;
  /** Credits bought and not spent yet. */
  credits: number;
  /** Unix seconds: when the free allowance is full again (next UTC midnight). */
  resetsAt: number;
  /** Units one encrypted input costs. */
  inputUnits: number;
  /** Units one value of a public decryption costs, when it is sent to Zama. */
  publicUnits: number;
}

/**
 * A public decryption sent to Zama, kept by its exact request. A handle decrypts to the same
 * value forever, so asking again is answered from here and Zama is paid once.
 */
export interface PublicDecryption {
  /** The handles in their order, and the extra data: what the KMS signs over. */
  key: string;
  jobId: string;
  /** Zama's "queued" answer to the request, replayed to whoever asks the same again. */
  queued: unknown;
  /** Zama's "succeeded" answer once the job is done; null while it runs. */
  result: unknown | null;
  /** Unix seconds, when it was sent. */
  at: number;
}

/** The cache key of a public decryption: order matters, the proof covers the list as given. */
export const publicDecryptionKey = (handles: string[], extraData: string) => `${handles.join(",")}|${extraData.toLowerCase()}`;

const DAY = 86_400;

/** The UTC day a moment falls in, as "2026-10-02". */
export const dayOf = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export const nextDayAt = (unixSeconds: number): number => (Math.floor(unixSeconds / DAY) + 1) * DAY;

/** Free units first, then credits. Null when both together fall short: nothing is taken. */
export function charge(units: number, m: Meter, freePerDay: number): Charge | null {
  if (units <= 0) return { free: 0, credits: 0 };
  const free = Math.min(units, Math.max(0, freePerDay - m.freeUsed));
  const credits = units - free;
  if (credits > Math.max(0, m.bought - m.spent)) return null;
  return { free, credits };
}

export const refund = (c: Charge): Charge => ({ free: -c.free, credits: -c.credits });

export function allowanceOf(m: Meter, freePerDay: number, now: number, inputUnits: number, publicUnits: number): Allowance {
  return {
    freePerDay,
    freeLeft: Math.max(0, freePerDay - m.freeUsed),
    credits: Math.max(0, m.bought - m.spent),
    resetsAt: nextDayAt(now),
    inputUnits,
    publicUnits,
  };
}
