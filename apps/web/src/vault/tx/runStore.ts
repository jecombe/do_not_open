import type { Step, TxRecord } from "@dno/chain-adapter";
import { siteHost } from "../../hosts";

/** One transaction of a run, as small as it can be: the run travels in a cookie. */
export interface RunTx {
  hash: string;
  call: string;
  status: TxRecord["status"];
  block?: number;
  /** Gas used, as a decimal string: a bigint does not survive JSON. */
  gas?: string;
}

/**
 * The vault's last action, as the page that ran it saw it go: its steps, its transactions, how it
 * ended. The vault's page writes it; every page of the secure theme (home, boarding, the docs, the
 * vault itself) reads it, so leaving the vault mid-way still shows where the action stood.
 */
export interface VaultRun {
  /** When it started, in ms: also its id. */
  id: number;
  /** The action's name, as the vault's page calls it ("deposit", "list" ...). */
  name: string;
  /** The box it was about, to open it again from elsewhere. */
  box?: number;
  /** For a deposit, how many decoys the new box went to. */
  decoys?: number;
  step: Step | null;
  /** The steps seen so far, in order, each with when it began. */
  steps: { step: Step; at: number }[];
  txs: RunTx[];
  /** The explorer's base for transaction links (`…/tx/<hash>`), or null without one. */
  explorer: string | null;
  status: "running" | "done" | "failed";
  /** How it ended, worded in the language of the page that ran it. */
  note?: string;
  /** Last sign of life from the page running it, in ms: a running action whose page is gone stops beating. */
  beat: number;
  /** Closed by the user: no page shows it any more. */
  dismissed?: boolean;
}

/** A running action whose page has not beaten for this long is taken for stopped. */
const STALE_MS = 9_000;
/** How often the running page beats. */
const BEAT_MS = 2_000;
/** A finished action stays on the other pages' dock this long, unless dismissed. */
const SHOWN_MS = 15 * 60_000;
const KEEP_TXS = 6;

/** Each network has its own cookie: the testnet's domain sits under the mainnet's. */
function cookieName(): string {
  const host = typeof location === "undefined" ? null : siteHost(location.hostname);
  return host?.domain.startsWith("testnet.") ? "dno_vault_run_testnet" : "dno_vault_run";
}

/** Shared by the bare domain and its `vault.` and `game.` subdomains; host-only anywhere else. */
function cookieDomain(): string {
  const host = siteHost(location.hostname);
  return host ? `; domain=.${host.domain}` : "";
}

function encode(run: VaultRun): string {
  const bytes = new TextEncoder().encode(JSON.stringify(run));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decode(value: string): VaultRun | null {
  try {
    const bin = atob(value);
    const run = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as VaultRun;
    return typeof run?.id === "number" && typeof run.name === "string" ? run : null;
  } catch {
    return null;
  }
}

function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const name = cookieName();
  for (const part of document.cookie.split("; ")) if (part.startsWith(`${name}=`)) return part.slice(name.length + 1);
  return null;
}

function writeCookie(run: VaultRun | null): void {
  try {
    const secure = location.protocol === "https:" ? "; secure" : "";
    const value = run ? encode(run) : "";
    document.cookie = `${cookieName()}=${value}; path=/; max-age=${run ? 86_400 : 0}; samesite=lax${cookieDomain()}${secure}`;
  } catch {
    // Cookies off: the run still shows on the page that runs it.
  }
}

// --- the store ---

/** This page's own run, while it lasts: the cookie mirrors it for the other pages. */
let own: VaultRun | null = null;
/** The last run read from the cookie, and its raw value, to notice changes cheaply. */
let shared: VaultRun | null = null;
let raw: string | null = null;
let beating: ReturnType<typeof setInterval> | null = null;
let hiding = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function save(run: VaultRun): void {
  own = run;
  shared = run;
  writeCookie(run);
  raw = readCookie();
  emit();
}

function update(id: number, change: (run: VaultRun) => VaultRun): void {
  if (!own || own.id !== id) return;
  save(change(own));
}

/** Reads the cookie again: another page (or tab) may have started, moved or closed a run. */
function poll(): void {
  const now = readCookie();
  if (now === raw) return;
  raw = now;
  shared = now ? decode(now) : null;
  emit();
}

/** Subscribes to runs, this page's and the others'. Polls the cookie while anyone listens. */
export function subscribeRuns(listener: () => void): () => void {
  listeners.add(listener);
  const id = setInterval(poll, 1_000);
  poll();
  return () => {
    listeners.delete(listener);
    clearInterval(id);
  };
}

/** The run to show: this page's own, else the last one any page left. */
export const currentRun = (): VaultRun | null => own ?? shared;
/** True when the run was started in this page. */
export const isOwnRun = (run: VaultRun | null): boolean => !!run && own?.id === run.id;

/** Starts a run in this page and keeps it beating until it ends. */
export function startRun(name: string, extra: { box?: number; decoys?: number } = {}): number {
  const now = Date.now();
  save({ id: now, name, ...extra, step: null, steps: [], txs: [], explorer: null, status: "running", beat: now });
  if (beating) clearInterval(beating);
  beating = setInterval(() => own?.status === "running" && update(own.id, (r) => ({ ...r, beat: Date.now() })), BEAT_MS);
  if (!hiding) {
    hiding = true;
    // Leaving the page stops what runs in it: the next page says so at once, not after the beat goes stale.
    addEventListener("pagehide", () => {
      if (own?.status === "running") writeCookie({ ...own, beat: 0 });
    });
  }
  return now;
}

export function runStep(id: number, step: Step): void {
  update(id, (r) => (r.step === step ? r : { ...r, step, steps: [...r.steps, { step, at: Date.now() }], beat: Date.now() }));
}

export function runTx(id: number, tx: TxRecord): void {
  update(id, (r) => {
    const seen = r.txs.find((x) => x.hash === tx.hash);
    const entry: RunTx = {
      hash: tx.hash,
      call: tx.call,
      status: tx.status,
      block: tx.block ?? seen?.block,
      gas: tx.gasUsed !== undefined ? tx.gasUsed.toString() : seen?.gas,
    };
    const txs = seen ? r.txs.map((x) => (x.hash === tx.hash ? entry : x)) : [...r.txs, entry].slice(-KEEP_TXS);
    const explorer = r.explorer ?? (tx.url ? tx.url.replace(/\/tx\/[^/]+$/, "") : null);
    return { ...r, txs, explorer, beat: Date.now() };
  });
}

/** Ends the run: done with what it did, or failed with why. */
export function endRun(id: number, status: "done" | "failed", note?: string): void {
  if (beating) clearInterval(beating);
  beating = null;
  update(id, (r) => ({ ...r, status, note, step: null, beat: Date.now() }));
}

/** Drops a run that never really started (the wallet was not ready, the form asked first). */
export function dropRun(id: number): void {
  if (!own || own.id !== id) return;
  if (beating) clearInterval(beating);
  beating = null;
  own = null;
  shared = null;
  writeCookie(null);
  raw = readCookie();
  emit();
}

/** Closes the run everywhere: no page's dock shows it again. */
export function dismissRun(): void {
  const run = currentRun();
  if (!run || (run.status === "running" && !isStale(run) && isOwnRun(run))) return;
  const closed = { ...run, dismissed: true };
  if (own?.id === run.id) own = closed;
  shared = closed;
  writeCookie(closed);
  raw = readCookie();
  emit();
}

/** A running run whose page stopped beating: it was closed or left before the end. */
export const isStale = (run: VaultRun, now = Date.now()): boolean => run.status === "running" && now - run.beat > STALE_MS;

/** Whether another page should still show the run on its dock. */
export const worthShowing = (run: VaultRun | null, now = Date.now()): run is VaultRun =>
  !!run && !run.dismissed && (run.status === "running" || now - run.beat < SHOWN_MS);

/** The explorer link of a transaction of the run, if the chain has one. */
export const txUrl = (run: VaultRun, hash: string): string | null => (run.explorer ? `${run.explorer}/tx/${hash}` : null);
