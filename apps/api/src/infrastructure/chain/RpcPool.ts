import type { Logger } from "../../application/ports/logger";

/**
 * Free public RPC endpoints, used without getting banned.
 *
 * - Several endpoints, each behind its own token bucket: the pool never sends one more than
 *   `rps` requests a second, and spreads the load.
 * - A 429 or an outage puts an endpoint in cooldown (honouring Retry-After, growing on repeat);
 *   the request moves to the next one.
 * - Each endpoint learns its own `eth_getLogs` block range from its refusals ("limited to 50
 *   blocks", "ranges over 10000 blocks", "more than 10000 results"...) and keeps to it.
 * - Errors that are the caller's (a revert, bad params) are thrown as they are and cost the
 *   endpoint nothing.
 */

export interface RpcPoolOptions {
  urls: string[];
  /** Requests per second per endpoint. Public endpoints tolerate a few. */
  rps: number;
  /** Bucket size: how many requests may go at once after a quiet spell. */
  burst?: number;
  timeoutMs?: number;
  /** Widest `eth_getLogs` range ever asked of an endpoint. */
  maxLogRange: number;
  /** Attempts across endpoints before a request fails. */
  attempts?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

export type FailureKind = "rate-limited" | "unavailable" | "range" | "fatal";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly code?: number,
    /** Seconds the endpoint asked us to wait, if it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface Endpoint {
  url: string;
  /** Host only: the URL may carry a key. */
  name: string;
  tokens: number;
  refilledAt: number;
  cooldownUntil: number;
  /** Consecutive failures: sets the length of the next cooldown. */
  strikes: number;
  logRange: number;
  /** A range the endpoint said it refuses beyond: never grow past it. */
  logCeiling: number;
  served: number;
  failed: number;
  /** Moving average of response times, in ms. Zero until measured: new endpoints get tried. */
  latencyMs: number;
}

export interface EndpointStatus {
  name: string;
  healthy: boolean;
  cooldownSeconds: number;
  logRange: number;
  latencyMs: number;
  served: number;
  failed: number;
}

export interface LogFilter {
  address: string[];
  topics?: (string | string[] | null)[];
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  blockHash?: string;
  removed?: boolean;
}

const RANGE_PATTERN = /block range|range (is )?too (large|wide|big)|ranges? over|limited to|max(imum)?( allowed)? (number of )?(requested )?blocks|too many (blocks|results|logs)|more than \d+ (results|logs)|response size|exceed(s|ed)? .*(range|results|size|logs)|query timeout|returned more than/i;
/** The endpoint will not serve this chain or this method to us: bench it, another one will. */
const REFUSED_PATTERN = /not available|upgrade|paid plan|not supported|unsupported|disabled|api.?key|unauthori[sz]ed|forbidden|method not found|not whitelisted/i;
const RATE_PATTERN = /rate.?limit|too many requests|capacity|throttl|exceeded.*(quota|limit)|quota|compute units|request limit/i;

export class RpcPool {
  private readonly endpoints: Endpoint[];
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private next = 0;
  private id = 0;

  constructor(private readonly opts: RpcPoolOptions) {
    if (!opts.urls.length) throw new Error("RpcPool needs at least one endpoint");
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.endpoints = opts.urls.map((url) => ({
      url,
      name: hostOf(url),
      tokens: this.burst,
      refilledAt: this.now(),
      cooldownUntil: 0,
      strikes: 0,
      logRange: opts.maxLogRange,
      logCeiling: opts.maxLogRange,
      served: 0,
      failed: 0,
      latencyMs: 0,
    }));
  }

  private get burst() {
    return this.opts.burst ?? Math.max(1, this.opts.rps * 2);
  }

  status(): EndpointStatus[] {
    const now = this.now();
    return this.endpoints.map((e) => ({
      name: e.name,
      healthy: e.cooldownUntil <= now,
      cooldownSeconds: Math.max(0, Math.ceil((e.cooldownUntil - now) / 1000)),
      logRange: e.logRange,
      latencyMs: Math.round(e.latencyMs),
      served: e.served,
      failed: e.failed,
    }));
  }

  /** One JSON-RPC call, on whichever endpoint can take it. */
  call<T>(method: string, params: unknown[]): Promise<T> {
    return this.withEndpoint((e) => this.send<T>(e, method, params, 1));
  }

  /**
   * Several calls in one HTTP request, counted as as many requests against the endpoint's
   * budget. Endpoints that refuse batches get the calls one at a time.
   */
  async batch<T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    if (!calls.length) return [];
    try {
      return await this.withEndpoint((e) => this.sendBatch<T>(e, calls));
    } catch (error) {
      if (error instanceof RpcError && error.kind === "fatal") {
        const out: T[] = [];
        for (const c of calls) out.push(await this.call<T>(c.method, c.params));
        return out;
      }
      throw error;
    }
  }

  /**
   * Logs of `from..to`, or of the first part of it the chosen endpoint accepts in one call.
   * Returns the last block covered.
   */
  getLogs(filter: LogFilter, from: number, to: number): Promise<{ logs: RawLog[]; to: number }> {
    return this.withEndpoint(async (e) => {
      for (let shrinks = 0; ; shrinks++) {
        const end = Math.min(to, from + e.logRange - 1);
        try {
          const logs = await this.send<RawLog[]>(e, "eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(end) }], 1);
          // It took this range: let it try a little wider next time, up to what it said it takes.
          e.logRange = Math.min(e.logCeiling, Math.ceil(e.logRange * 1.25));
          return { logs: logs.filter((l) => !l.removed), to: end };
        } catch (error) {
          if (!(error instanceof RpcError) || error.kind !== "range") throw error;
          // Still refusing after several cuts: it is not about the range. Let another endpoint try.
          if (shrinks >= 6 || e.logRange <= 1) throw new RpcError(error.message, "unavailable", error.code);
          this.shrink(e, error.message, end - from + 1);
        }
      }
    });
  }

  /** Narrows an endpoint's range after a refusal, to the limit it named if it named one. */
  private shrink(e: Endpoint, message: string, span: number) {
    // A limit in blocks is taken as said; one in results or bytes depends on the blocks, so halve.
    const named = !/block/i.test(message)
      ? []
      : [...message.matchAll(/\d[\d,_]*/g)].map((m) => Number(m[0].replace(/[,_]/g, ""))).filter((n) => n >= 1 && n < span);
    if (named.length) {
      // "limited to 0 - 50 blocks": the widest number under the span is the limit; ranges are inclusive.
      e.logCeiling = Math.max(...named);
      e.logRange = e.logCeiling;
    } else {
      e.logRange = Math.max(1, Math.floor(span / 2));
    }
    this.opts.log?.debug({ endpoint: e.name, logRange: e.logRange }, "log range narrowed");
  }

  /** Runs `run` on the best endpoint, moving to another on rate limits and outages. */
  private async withEndpoint<T>(run: (e: Endpoint) => Promise<T>): Promise<T> {
    const attempts = this.opts.attempts ?? Math.max(3, this.endpoints.length * 2);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      const e = await this.pick();
      try {
        const result = await run(e);
        e.strikes = Math.max(0, e.strikes - 1);
        e.served++;
        return result;
      } catch (error) {
        if (!(error instanceof RpcError) || error.kind === "fatal" || error.kind === "range") throw error;
        last = error;
        e.failed++;
        e.strikes++;
        const backoff = error.kind === "rate-limited" ? Math.min(60_000, 2_000 * 2 ** (e.strikes - 1)) : Math.min(300_000, 5_000 * 2 ** (e.strikes - 1));
        e.cooldownUntil = this.now() + Math.max(backoff, (error.retryAfter ?? 0) * 1000);
        this.opts.log?.warn({ endpoint: e.name, kind: error.kind, cooldownMs: e.cooldownUntil - this.now(), error: error.message }, "rpc endpoint benched");
      }
    }
    throw last;
  }

  /**
   * The healthy endpoint with the fewest strikes; among those, one with a token to spend right
   * now, the fastest first. Equals take turns. Waits if every endpoint rests.
   */
  private async pick(): Promise<Endpoint> {
    for (;;) {
      const now = this.now();
      const healthy = this.endpoints.filter((e) => e.cooldownUntil <= now);
      if (healthy.length) {
        const fewest = Math.min(...healthy.map((e) => e.strikes));
        let best = healthy.filter((e) => e.strikes === fewest);
        const ready = best.filter((e) => this.tokensAt(e, now) >= 1);
        if (ready.length) best = ready;
        const fastest = Math.min(...best.map((e) => e.latencyMs));
        // Within 50% of the fastest counts as fast: no point piling everything on one node.
        best = best.filter((e) => e.latencyMs <= fastest * 1.5 + 50);
        return best[this.next++ % best.length]!;
      }
      const wake = Math.min(...this.endpoints.map((e) => e.cooldownUntil));
      await this.sleep(Math.max(50, wake - now));
    }
  }

  private tokensAt(e: Endpoint, now: number) {
    return Math.min(this.burst, e.tokens + ((now - e.refilledAt) / 1000) * this.opts.rps);
  }

  /** Takes `n` tokens from the endpoint's bucket, waiting for them if needed. */
  private async take(e: Endpoint, n: number) {
    const rps = this.opts.rps;
    for (;;) {
      const now = this.now();
      e.tokens = Math.min(this.burst, e.tokens + ((now - e.refilledAt) / 1000) * rps);
      e.refilledAt = now;
      // A batch bigger than the bucket goes once the bucket is full.
      const need = Math.min(n, this.burst);
      if (e.tokens >= need) {
        e.tokens -= need;
        return;
      }
      await this.sleep(Math.ceil(((need - e.tokens) / rps) * 1000));
    }
  }

  private async post(e: Endpoint, body: unknown, cost: number): Promise<unknown> {
    await this.take(e, cost);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000);
    let res: Response;
    const started = this.now();
    try {
      res = await this.fetch(e.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      // A timeout counts as slow as it gets.
      e.latencyMs = e.latencyMs * 0.7 + (this.now() - started) * 0.3;
      throw new RpcError(`${e.name}: ${(error as Error).message}`, "unavailable");
    } finally {
      clearTimeout(timer);
    }
    const took = this.now() - started;
    e.latencyMs = e.latencyMs === 0 ? took : e.latencyMs * 0.7 + took * 0.3;
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    if (res.status === 429) throw new RpcError(`${e.name}: HTTP 429`, "rate-limited", 429, retryAfter);
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RpcError(`${e.name}: HTTP ${res.status}, not JSON`, res.status >= 500 || res.status === 404 ? "unavailable" : "fatal", res.status);
    }
    if (res.status >= 500 && !isRpcPayload(json)) throw new RpcError(`${e.name}: HTTP ${res.status}`, "unavailable", res.status);
    return json;
  }

  private async send<T>(e: Endpoint, method: string, params: unknown[], cost: number): Promise<T> {
    const json = (await this.post(e, { jsonrpc: "2.0", id: ++this.id, method, params }, cost)) as JsonRpcResponse;
    if (json.error) throw classify(e.name, method, json.error);
    if (!("result" in json)) throw new RpcError(`${e.name}: no result`, "unavailable");
    return json.result as T;
  }

  private async sendBatch<T>(e: Endpoint, calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    const first = this.id + 1;
    const body = calls.map((c) => ({ jsonrpc: "2.0", id: ++this.id, method: c.method, params: c.params }));
    const json = await this.post(e, body, calls.length);
    if (!Array.isArray(json)) {
      const err = (json as JsonRpcResponse).error;
      throw err ? classify(e.name, "batch", err) : new RpcError(`${e.name}: batch refused`, "fatal");
    }
    const byId = new Map((json as JsonRpcResponse[]).map((r) => [r.id, r]));
    return calls.map((c, i) => {
      const r = byId.get(first + i);
      if (!r) throw new RpcError(`${e.name}: batch answer missing`, "unavailable");
      if (r.error) throw classify(e.name, c.method, r.error);
      return r.result as T;
    });
  }
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const isRpcPayload = (json: unknown) => !!json && typeof json === "object" && ("result" in json || "error" in json || Array.isArray(json));

function classify(endpoint: string, method: string, error: { code?: number; message?: string }): RpcError {
  const message = `${endpoint}: ${error.message ?? "error"}`;
  const text = error.message ?? "";
  if (method === "eth_getLogs" && RANGE_PATTERN.test(text)) return new RpcError(message, "range", error.code);
  if (RATE_PATTERN.test(text) || error.code === 429) return new RpcError(message, "rate-limited", error.code);
  if (REFUSED_PATTERN.test(text) || error.code === -32601) return new RpcError(message, "unavailable", error.code);
  // Server-side trouble that another endpoint may not have.
  if (error.code === -32603 || (error.code === -32000 && /header not found|unknown block|timeout|unavailable|internal/i.test(text))) return new RpcError(message, "unavailable", error.code);
  return new RpcError(message, "fatal", error.code);
}

const hex = (n: number) => `0x${n.toString(16)}`;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}
