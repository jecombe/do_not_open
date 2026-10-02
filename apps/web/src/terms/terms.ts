import { useSyncExternalStore } from "react";
import type { Address, SignedTerms } from "@dno/chain-adapter";
import { en } from "../i18n/app/en";

/**
 * The terms of play, in English: the text a player signs. Translations in the app dictionaries
 * are for reading only. A new version (any change to a clause) asks everyone to sign again.
 */
export const TERMS_VERSION = "2026-10-03";

export const CLAUSES: { title: string; body: string }[] = [
  {
    title: "Experimental software",
    body: "DO NOT OPEN is an experimental game running on public blockchains and on Zama's FHEVM, a young technology. On a test network it uses tokens without value. It is provided as is, without warranty of any kind.",
  },
  {
    title: "Smart contract risk",
    body: "The smart contracts may contain bugs or be attacked, and a hack can lead to the loss of boxes, cats or tokens. You play at your own risk. To the extent the law allows, the creators and operators of DO NOT OPEN are not liable for losses caused by a bug, an exploit or a hack of the game's contracts or of the third-party contracts they use (tokens, pools, wrappers).",
  },
  {
    title: "The website is only a window",
    body: "This site is an interface to contracts that live on the chain. It can be down, slow, show out-of-date or wrong figures, or have bugs. None of that moves your assets: your boxes and tokens are recorded on-chain, not on the site, and the contracts can be used without it. A bug on the site does not mean anything was lost.",
  },
  {
    title: "Nobody holds your keys",
    body: "The game is non-custodial: nobody but you holds your wallet, your keys or your funds, and nobody can recover them or reverse a transaction for you. Keeping your wallet safe is your responsibility.",
  },
  {
    title: "Third parties",
    body: "Privacy relies on Zama's protocol, relayer and key management service, and payments on third-party tokens and pools. If they fail, slow down or change, decryptions or payments may be delayed or impossible for a while, and the creators of DO NOT OPEN are not liable for it.",
  },
  {
    title: "Not an investment",
    body: "Boxes, cats and croquettes are game items. Nothing here is financial advice or a promise of profit; prices are set by players and can fall to zero. Fees and gas are not refundable, and transactions on a blockchain are final.",
  },
  {
    title: "Your side",
    body: "You are of legal age where you live, playing is lawful for you there, and you handle your own taxes. You will not use the game to break the law, nor attack the game or its players.",
  },
  {
    title: "Limits, and what changes",
    body: "Nothing in these terms limits a liability that the law does not allow to be limited. These terms may change: a new version will be shown, and must be signed again to play on. Your signature is free, sends no transaction, and is kept as a record of your acceptance.",
  },
];

// The English dictionary shows the clauses in the app: it must say exactly what is signed.
if (import.meta.env.DEV) {
  CLAUSES.forEach((c, i) => {
    const d = en as Record<string, string>;
    if (d[`terms.c${i + 1}.title`] !== c.title || d[`terms.c${i + 1}.body`] !== c.body) console.warn(`[terms] clause ${i + 1} differs between terms.ts and the English dictionary`);
  });
}

/** The full English text, exactly as hashed. */
export function termsText(): string {
  return [`DO NOT OPEN, terms of play, version ${TERMS_VERSION}`, ...CLAUSES.map((c, i) => `${i + 1}. ${c.title}\n${c.body}`)].join("\n\n");
}

let hashed: Promise<string> | null = null;
/** SHA-256 of the full English text, lowercase hex: what the signature points at. */
export function termsHash(): Promise<string> {
  hashed ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(termsText())).then((buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  return hashed;
}

/** What the wallet shows and signs: readable on its own, bound to the address, the version and the text. */
export function termsMessage(account: Address, hash: string, at: Date): string {
  return [
    `DO NOT OPEN · Release form ${TERMS_VERSION}`,
    "",
    `I, ${account}, have read and accept the terms of DO NOT OPEN, version ${TERMS_VERSION}, whose full English text has this SHA-256:`,
    hash,
    "",
    "In short:",
    "- The smart contracts are experimental and can be hacked or have bugs: I play at my own risk.",
    "- The site can break; my boxes and tokens live on-chain, not on the site.",
    "- Nobody but me holds my keys or my funds.",
    "- Nothing here is financial advice, and transactions cannot be undone.",
    "",
    `Signed on ${at.toISOString()}. This signature is free and sends no transaction.`,
  ].join("\n");
}

// --- what this browser remembers, per version: that the clauses were read, and each wallet's signature

export interface TermsRecord {
  /** Every clause initialed in this browser, with or without a wallet. */
  initialed: boolean;
  /** By lowercase address. */
  signed: Record<string, SignedTerms & { at: number }>;
}

const KEY = `dno.terms.${TERMS_VERSION}`;
const listeners = new Set<() => void>();
const blank: TermsRecord = { initialed: false, signed: {} };

function read(): TermsRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as TermsRecord | null;
    return raw && typeof raw === "object" ? { initialed: !!raw.initialed, signed: raw.signed ?? {} } : blank;
  } catch {
    return blank;
  }
}

let current = read();

function write(next: TermsRecord): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode: the form is signed for this visit, and asked again on the next.
  }
  for (const l of listeners) l();
}

export function markInitialed(): void {
  write({ ...current, initialed: true });
}

export function keepSignature(s: SignedTerms): void {
  write({ initialed: true, signed: { ...current.signed, [s.account.toLowerCase()]: { ...s, at: Date.now() } } });
}

export function useTermsRecord(): TermsRecord {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

const openers = new Set<() => void>();
/** The menu's "Terms of play": shows the form again, with the signature if there is one. */
export function openTerms(): void {
  for (const o of openers) o();
}
export function onOpenTerms(listener: () => void): () => void {
  openers.add(listener);
  return () => void openers.delete(listener);
}
