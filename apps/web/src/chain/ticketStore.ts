import type { TraitRoll } from "@dno/chain-adapter";
import { spec as gameSpec } from "@dno/game-spec";

/** How many traits a ticket has room for, one line each. */
export const TICKET_LINES = gameSpec.traits.length;

/** One trait a shake showed, and when. */
export interface TicketLine {
  roll: number;
  /** The first and the latest shake that landed on this trait, in ms since the epoch. */
  firstAt: number;
  lastAt: number;
}

/** Everything one account learned by shaking one box, kept for good: a seed never changes, so
 *  neither does a roll. Lines are indexed like `spec.traits`; null is a trait not felt yet. */
export interface Ticket {
  lines: (TicketLine | null)[];
  shakes: number;
}

type Store = Record<string, Ticket>;

// A shake is readable by the shaker alone, so its ticket is kept in their browser only: one
// entry per contract and account, so another wallet or another deployment starts empty.
const key = (contract: string, account: string) => `dno:ticket:v1:${contract.toLowerCase()}:${account.toLowerCase()}`;
// What earlier versions kept for 24 hours, folded into the tickets on first read.
const legacyKey = (contract: string, account: string) => `dno:felt:${contract.toLowerCase()}:${account.toLowerCase()}`;

const empty = (): Ticket => ({ lines: Array<TicketLine | null>(TICKET_LINES).fill(null), shakes: 0 });

/** Writes one shake onto a ticket, and returns the new ticket. */
function punch(ticket: Ticket, roll: TraitRoll, at: number): Ticket {
  const lines = [...ticket.lines];
  const seen = lines[roll.traitIndex];
  if (seen && seen.roll !== roll.roll) console.warn("[ticket] the same trait came back with another roll", { seen, roll });
  lines[roll.traitIndex] = seen ? { roll: roll.roll, firstAt: Math.min(seen.firstAt, at), lastAt: Math.max(seen.lastAt, at) } : { roll: roll.roll, firstAt: at, lastAt: at };
  return { lines, shakes: ticket.shakes + 1 };
}

function read(contract: string, account: string): Store {
  let store: Store = {};
  try {
    store = JSON.parse(localStorage.getItem(key(contract, account)) ?? "{}") as Store;
  } catch {
    return {};
  }
  try {
    const legacy = localStorage.getItem(legacyKey(contract, account));
    if (legacy === null) return store;
    const felt = JSON.parse(legacy) as Record<string, (TraitRoll & { at: number })[]>;
    for (const [id, list] of Object.entries(felt)) {
      for (const f of [...list].reverse()) store[id] = punch(store[id] ?? empty(), f, f.at);
    }
    localStorage.setItem(key(contract, account), JSON.stringify(store));
    localStorage.removeItem(legacyKey(contract, account));
  } catch {
    // A legacy entry that does not parse is simply left behind.
  }
  return store;
}

/** Every ticket `account` holds on this contract, by token id. */
export function allTickets(contract: string, account: string): Record<number, Ticket> {
  return read(contract, account);
}

/** The ticket `account` holds for `tokenId`, or null if they never shook it. */
export function recallTicket(contract: string, account: string, tokenId: number): Ticket | null {
  return read(contract, account)[tokenId] ?? null;
}

/** Prints a shake's answer on the box's ticket, and returns the ticket. */
export function punchTicket(contract: string, account: string, tokenId: number, roll: TraitRoll, now = Date.now()): Ticket {
  const store = read(contract, account);
  const ticket = punch(store[tokenId] ?? empty(), roll, now);
  store[tokenId] = ticket;
  try {
    localStorage.setItem(key(contract, account), JSON.stringify(store));
  } catch {
    // Private windows may refuse storage: the ticket still shows until the page closes.
  }
  return ticket;
}

/** How many of the traits the ticket shows. */
export const felt = (ticket: Ticket) => ticket.lines.filter(Boolean).length;
