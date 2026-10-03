import { createHmac, randomBytes } from "node:crypto";
import { NetworkBusy, type SocialNetwork } from "../../application/ports/herald";

export interface XCredentials {
  /** The app's consumer key and secret. */
  apiKey: string;
  apiSecret: string;
  /** The account's own access token and secret: the app posts as that account. */
  accessToken: string;
  accessSecret: string;
}

const TWEETS = "https://api.x.com/2/tweets";

/** RFC 3986 percent-encoding, as OAuth 1.0a wants it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The `Authorization` header of an OAuth 1.0a request signed with HMAC-SHA1. `params` are the
 * query and form parameters (none for a JSON body, which is not signed).
 */
export function oauthHeader(
  method: string,
  url: string,
  params: Record<string, string>,
  creds: XCredentials,
  nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const all = Object.entries({ ...params, ...oauth })
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(all)}`;
  const signature = createHmac("sha1", `${enc(creds.apiSecret)}&${enc(creds.accessSecret)}`).update(base).digest("base64");
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature })
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(", ")}`;
}

/** Posts on X as the collection's account, through the v2 API. */
export class XNetwork implements SocialNetwork {
  readonly name = "x";

  constructor(
    private readonly creds: XCredentials,
    /** The account's handle, for links to its posts. */
    private readonly handle: string | null,
    private readonly timeoutMs = 15_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async post(text: string) {
    const res = await this.fetcher(TWEETS, {
      method: "POST",
      headers: { authorization: oauthHeader("POST", TWEETS, {}, this.creds), "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      throw new NetworkBusy(Number.isFinite(reset) && reset > 0 ? reset : null);
    }
    const body = (await res.json().catch(() => null)) as { data?: { id?: string }; detail?: string; title?: string } | null;
    if (!res.ok || !body?.data?.id) throw new Error(`X refused the post (${res.status}): ${body?.detail ?? body?.title ?? "no detail"}`);
    const id = body.data.id;
    return { id, url: this.handle ? `https://x.com/${this.handle}/status/${id}` : `https://x.com/i/web/status/${id}` };
  }
}
