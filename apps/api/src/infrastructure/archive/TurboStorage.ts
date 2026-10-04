import type { PermanentStorage } from "../../application/ports/archive";
import { signDataItem } from "./ans104";

export interface TurboOptions {
  /** Signs the uploads. Any Ethereum key: it needs no funds, it only shows who uploaded. */
  privateKey: string;
  /** e.g. https://upload.ardrive.io */
  uploadUrl: string;
  /** Largest data item the bundler takes for free. */
  maxBytes: number;
  timeoutMs: number;
  appName: string;
}

/** Room the envelope takes beside the image: signature, owner, flags and tags. */
const ENVELOPE_BYTES = 1024;

/**
 * Arweave through ArDrive's Turbo bundler, which stores small data items for free. Each upload
 * is an ANS-104 data item signed with an Ethereum key, sent as is to `/v1/tx/ethereum`.
 */
export class TurboStorage implements PermanentStorage {
  readonly maxBytes: number;

  constructor(private readonly o: TurboOptions) {
    this.maxBytes = o.maxBytes - ENVELOPE_BYTES;
  }

  async put(data: Uint8Array, contentType: string): Promise<string> {
    const item = await signDataItem(this.o.privateKey, data, [
      { name: "Content-Type", value: contentType },
      { name: "App-Name", value: this.o.appName },
    ]);
    const res = await fetch(`${this.o.uploadUrl.replace(/\/$/, "")}/v1/tx/ethereum`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from(item.bytes),
      signal: AbortSignal.timeout(this.o.timeoutMs),
    });
    if (!res.ok) throw new Error(`Turbo upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { id?: string };
    if (body.id !== item.id) throw new Error(`Turbo answered id ${body.id}, expected ${item.id}`);
    return item.id;
  }
}
