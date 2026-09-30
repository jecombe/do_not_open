import type { TxRecord } from "@dno/chain-adapter";

/** One transaction sent about a pair of boxes, as this browser saw it go through. */
export interface LoggedTx {
  hash: string;
  call: string;
  status: TxRecord["status"];
  url: string | null;
  block?: number;
  /** Gas used, as a decimal string: a bigint does not survive JSON. */
  gas?: string;
  /** When it was sent, in ms since the epoch. */
  at: number;
}

/** Older entries drop off: this is a receipt drawer, not an archive. */
const KEEP = 20;

type Store = Record<string, LoggedTx[]>;

// Kept per contract, so a redeployment starts with an empty drawer; per pair, whichever side each box is on.
const key = (contract: string) => `dno:txlog:${contract.toLowerCase()}`;
const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function read(contract: string): Store {
  try {
    return JSON.parse(localStorage.getItem(key(contract)) ?? "{}") as Store;
  } catch {
    return {};
  }
}

/** What was sent about these two boxes from this browser, newest first. */
export function recallTxs(contract: string, a: number, b: number): LoggedTx[] {
  return read(contract)[pairKey(a, b)] ?? [];
}

/** Adds a transaction, or updates it as it gets mined. Returns the pair's list. */
export function logTx(contract: string, a: number, b: number, tx: TxRecord, now = Date.now()): LoggedTx[] {
  const store = read(contract);
  const k = pairKey(a, b);
  const list = store[k] ?? [];
  const seen = list.find((x) => x.hash === tx.hash);
  const entry: LoggedTx = {
    hash: tx.hash,
    call: tx.call,
    status: tx.status,
    url: tx.url,
    block: tx.block ?? seen?.block,
    gas: tx.gasUsed !== undefined ? tx.gasUsed.toString() : seen?.gas,
    at: seen?.at ?? now,
  };
  store[k] = [entry, ...list.filter((x) => x.hash !== tx.hash)].sort((x, y) => y.at - x.at).slice(0, KEEP);
  try {
    localStorage.setItem(key(contract), JSON.stringify(store));
  } catch {
    // Private windows may refuse storage: the list still shows until the page closes.
  }
  return store[k];
}
