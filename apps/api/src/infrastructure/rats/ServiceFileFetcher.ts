import type { ServiceFiles } from "../../application/ports/rats";

/**
 * Reads back a file one of the studio's services made: https on its own hosts only, never more than
 * `maxBytes`, whatever the server says.
 */
export class ServiceFileFetcher implements ServiceFiles {
  constructor(
    private readonly hosts: string[] = ["fal.media", "fal.run", "fal.ai"],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  async get(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !this.hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
      throw new Error(`not one of the service's hosts: ${u.hostname}`);
    }
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok || !res.body) throw new Error(`the service answered ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new Error("the file is too large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error("the file is too large");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { bytes, contentType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim() };
  }
}
