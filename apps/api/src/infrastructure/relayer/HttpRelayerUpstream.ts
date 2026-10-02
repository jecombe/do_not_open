import type { RelayerUpstream, UpstreamReply } from "../../application/ports/relayer";

/**
 * Zama's relayer over HTTP. The API key, when there is one (mainnet), is added here and never
 * leaves the server. On Sepolia the relayer is open and the key is left out.
 */
export class HttpRelayerUpstream implements RelayerUpstream {
  constructor(
    /** The relayer's versioned base, e.g. https://relayer.testnet.zama.org/v2 */
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  post(path: string, body: unknown): Promise<UpstreamReply> {
    return this.send(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  }

  get(path: string): Promise<UpstreamReply> {
    return this.send(path, { method: "GET", headers: {} });
  }

  private async send(path: string, init: { method: string; body?: string; headers: Record<string, string> }): Promise<UpstreamReply> {
    const headers = { ...init.headers, ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) };
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/${path}`, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Passed on as text: the SDK reports what it cannot read.
    }
    return { status: res.status, body, retryAfter: res.headers.get("retry-after") };
  }
}
