import type { Address, ApiSession } from "@dno/chain-adapter";

/** One session per account: switching wallets and back does not ask for a new signature. */
const KEY = "dno.studio.sessions";
/** Where a single session was kept before. */
const LEGACY_KEY = "dno.studio.session";

type Sessions = Record<string, ApiSession>;

const live = (s: ApiSession | undefined | null): s is ApiSession => !!s && s.expiresAt > Date.now() / 1000 + 60;

function read(): Sessions {
  try {
    const all = (JSON.parse(window.localStorage.getItem(KEY) ?? "null") ?? {}) as Sessions;
    const legacy = JSON.parse(window.localStorage.getItem(LEGACY_KEY) ?? "null") as ApiSession | null;
    if (legacy && !all[legacy.account.toLowerCase()]) all[legacy.account.toLowerCase()] = legacy;
    return all;
  } catch {
    // Blocked or broken storage: sign in again.
    return {};
  }
}

function write(all: Sessions): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // The session then lasts as long as the page.
  }
}

/** The studio's API session for `account`, if this browser has one that has not expired. */
export function storedSession(account: Address | null): ApiSession | null {
  if (!account) return null;
  const s = read()[account.toLowerCase()];
  return live(s) ? s : null;
}

/** Keeps `session`, or with `null` forgets the one of `account`. Expired ones are dropped on the way. */
export function storeSession(session: ApiSession | null, account?: Address | null): void {
  const all = Object.fromEntries(Object.entries(read()).filter(([, s]) => live(s)));
  if (session) all[session.account.toLowerCase()] = session;
  else if (account) delete all[account.toLowerCase()];
  write(all);
}
