import type { Address, ApiSession } from "@dno/chain-adapter";

const KEY = "dno.studio.session";

/** The studio's API session for `account`, if this browser has one that has not expired. */
export function storedSession(account: Address | null): ApiSession | null {
  if (!account) return null;
  try {
    const s = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as ApiSession | null;
    if (s && s.account.toLowerCase() === account.toLowerCase() && s.expiresAt > Date.now() / 1000 + 60) return s;
  } catch {
    // Blocked or broken storage: sign in again.
  }
  return null;
}

export function storeSession(session: ApiSession | null): void {
  try {
    if (session) window.localStorage.setItem(KEY, JSON.stringify(session));
    else window.localStorage.removeItem(KEY);
  } catch {
    // The session then lasts as long as the page.
  }
}
