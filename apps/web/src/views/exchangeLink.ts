import type { TokenKey } from "../chain/exchange";

/** What a link to the bureau de change asks for: a pair, and maybe an amount to start from. */
export interface ExchangePreset {
  from?: TokenKey;
  to?: TokenKey;
  /** In the `from` token's smallest unit. */
  amount?: bigint;
}

const listeners = new Set<(preset: ExchangePreset) => void>();
let pending: ExchangePreset | null = null;

/** Any view may send the user to the bureau de change, with the pair they came for. */
export function openExchange(preset: ExchangePreset = {}): void {
  pending = preset;
  for (const l of listeners) l(preset);
}

export function onOpenExchange(listener: (preset: ExchangePreset) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The preset the last link carried, once: the bureau takes it when it opens. */
export function takePreset(): ExchangePreset | null {
  const p = pending;
  pending = null;
  return p;
}
