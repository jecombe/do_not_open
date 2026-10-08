import { useCallback, useEffect, useState } from "react";
import { chainMode } from "./chain/mode";
import { apiUrl } from "./apiUrl";

/** The tasks on X a pass asks for, declared by the player (X's likes and reposts cannot be read for free). */
export type XTask = "follow" | "post" | "like" | "reply" | "repost";

/** An X boarding pass as the API shows it to its holder (`/v1/xpass`). */
export interface XPassView {
  code: string;
  /** Whether the pass holds a seat on the mainnet list: account connected, every required task done. */
  seated: boolean;
  /** Lower-cased, once a post proved the account. */
  handle: string | null;
  tweetUrl: string | null;
  followed: boolean;
  tasks: Record<XTask, boolean>;
  address: string | null;
  /** Whether the holder joined the Discord server and proved it with `/board`. */
  discord: boolean;
  bonus: number;
  /** The code of the pass whose referral link this one started from. */
  referredBy: string | null;
  /** The passes this one referred: those that earn points (seated, wallet linked) and the others. */
  referrals: { counted: number; pending: number };
}

/** Why the API refused, as its `error` code (`no-pass`, `code-missing`…), or `network`. */
export class XPassError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// The token is the pass: kept in this browser only, sent as a bearer to the API.
const TOKEN = "dno:xpass:token";

const readToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN);
  } catch {
    return null;
  }
};

const writeToken = (token: string | null) => {
  try {
    if (token) localStorage.setItem(TOKEN, token);
    else localStorage.removeItem(TOKEN);
  } catch {
    // A private window keeps nothing: the pass lives as long as the page.
  }
};

/** The API's base, or null in the demo and where none is set: then there is no pass to keep. */
export const xPassApi = (): string | null => (chainMode().mode === "mock" ? null : apiUrl());

let memoryToken: string | null = null;

async function call(method: "GET" | "POST", path: string, body?: object): Promise<XPassView> {
  const api = xPassApi();
  if (!api) throw new XPassError("network");
  const token = memoryToken ?? readToken();
  let res: Response;
  try {
    res = await fetch(`${api}/v1/xpass${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new XPassError("network");
  }
  const json = (await res.json().catch(() => ({}))) as { data?: XPassView | { token: string; pass: XPassView }; error?: string };
  if (!res.ok || !json.data) throw new XPassError(json.error ?? "network");
  if ("token" in json.data) {
    memoryToken = json.data.token;
    writeToken(json.data.token);
    return json.data.pass;
  }
  return json.data;
}

export const startXPass = (ref: string | null = null) => call("POST", "", ref ? { ref } : undefined);
export const referXPass = (code: string) => call("POST", "/referrer", { code });
export const xPassStatus = () => call("GET", "");
export const followXPass = () => call("POST", "/follow");
export const declareXTask = (task: XTask) => call("POST", "/task", { task });
export const verifyXPassTweet = (url: string) => call("POST", "/tweet", { url });
export const linkXPassWallet = (address: string, message: string, signature: string) => call("POST", "/wallet", { address, message, signature });
/** What the API says about X: whether Sign in with X is on (without it, a post carrying the
 *  pass code proves the account), the announcement post the tasks are about, and whether the
 *  Discord step (`/board`) is on. */
export async function xSettings(): Promise<{ signIn: boolean; announcement: string | null; discord: boolean }> {
  const api = xPassApi();
  if (!api) return { signIn: false, announcement: null, discord: false };
  try {
    const res = await fetch(`${api}/v1/xpass/x`);
    const data = res.ok ? ((await res.json()) as { data?: { signIn?: boolean; announcement?: string | null; discord?: boolean } }).data : undefined;
    return { signIn: data?.signIn === true, announcement: data?.announcement ?? null, discord: data?.discord === true };
  } catch {
    return { signIn: false, announcement: null, discord: false };
  }
}

/** A one-time code for `/board` on Discord, good until `expiresAt` (seconds). */
export async function discordBoardCode(): Promise<{ code: string; expiresAt: number }> {
  const api = xPassApi();
  if (!api) throw new XPassError("network");
  const token = memoryToken ?? readToken();
  let res: Response;
  try {
    res = await fetch(`${api}/v1/xpass/discord`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new XPassError("network");
  }
  const json = (await res.json().catch(() => ({}))) as { data?: { code: string; expiresAt: number }; error?: string };
  if (!res.ok || !json.data) throw new XPassError(json.error ?? "network");
  return json.data;
}

/** Sends the browser to X to sign in; X sends it back to `returnTo` with `?x=<outcome>#boarding`. */
export async function signInWithX(returnTo: string): Promise<void> {
  const api = xPassApi();
  if (!api) throw new XPassError("network");
  const token = memoryToken ?? readToken();
  let res: Response;
  try {
    res = await fetch(`${api}/v1/xpass/x/start`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ returnTo }),
    });
  } catch {
    throw new XPassError("network");
  }
  const json = (await res.json().catch(() => ({}))) as { data?: { url?: string }; error?: string };
  if (!res.ok || !json.data?.url) throw new XPassError(json.error ?? "network");
  window.location.assign(json.data.url);
}

/** Seats on the mainnet list: how many are taken, out of how many (null: no cap). */
export interface SeatsView {
  taken: number;
  places: number | null;
  /** The tasks on X a pass needs for a seat. */
  required: XTask[];
}

/** The list's seats, read from the API and again every `refreshMs`; null without the API. */
export function useSeats(refreshMs = 20_000): SeatsView | null {
  const [seats, setSeats] = useState<SeatsView | null>(null);
  useEffect(() => {
    const api = xPassApi();
    if (!api) return;
    let on = true;
    const read = () =>
      fetch(`${api}/v1/seats`)
        .then((r) => (r.ok ? (r.json() as Promise<{ data: SeatsView }>) : null))
        .then((j) => on && j && setSeats(j.data))
        .catch(() => undefined);
    void read();
    const timer = setInterval(read, refreshMs);
    return () => {
      on = false;
      clearInterval(timer);
    };
  }, [refreshMs]);
  return seats;
}

export const hasXPassToken = () => !!(memoryToken ?? readToken());

// The code of the pass whose link brought this browser (`?ref=DNO-XXXXXX`), until a pass takes it.
const REF = "dno:xpass:ref";
const REF_CODE = /^DNO-[A-Z0-9]{6}$/;

/** Keeps a `?ref=` from the address for the pass this browser starts later, and takes it off the
 *  address so a link copied from here does not carry someone else's code. */
export function rememberReferral(): void {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get("ref")?.trim().toUpperCase();
  if (!ref) return;
  if (REF_CODE.test(ref)) {
    try {
      localStorage.setItem(REF, ref);
    } catch {
      memoryRef = ref;
    }
  }
  params.delete("ref");
  const q = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
}

let memoryRef: string | null = null;

/** The referrer's code this browser keeps, if any. */
export function pendingReferral(): string | null {
  try {
    return localStorage.getItem(REF) ?? memoryRef;
  } catch {
    return memoryRef;
  }
}

export function forgetReferral(): void {
  memoryRef = null;
  try {
    localStorage.removeItem(REF);
  } catch {
    // Nothing kept.
  }
}

/** The link that brings a friend to the boarding page with this pass as their referrer. */
export function referralUrl(origin: string, applyPath: string, code: string): string {
  return `${origin}${applyPath}?ref=${encodeURIComponent(code)}`;
}

/** The pass this browser holds, read once; null when it has none (or lost it). */
export function useXPass(): { pass: XPassView | null; loading: boolean; set: (p: XPassView | null) => void } {
  const [pass, setPass] = useState<XPassView | null>(null);
  const [loading, setLoading] = useState(() => hasXPassToken() && !!xPassApi());
  useEffect(() => {
    if (!hasXPassToken() || !xPassApi()) return;
    let on = true;
    xPassStatus().then(
      (p) => on && setPass(p),
      (e: unknown) => {
        // A token the API does not know any more is dropped; a network error keeps it for later.
        if (e instanceof XPassError && e.code === "no-pass") writeToken(null);
      },
    ).finally(() => on && setLoading(false));
    return () => {
      on = false;
    };
  }, []);
  const set = useCallback((p: XPassView | null) => setPass(p), []);
  return { pass, loading, set };
}
