/**
 * The API's vault relayer: it sends a holder's request (and its proof) from its own wallet, so
 * the holder's address appears in no transaction. It only ever sees what any observer of the
 * chain would see once the transaction is sent: the box, the action, its terms, and a key
 * encrypted for the vault and bound to those terms, which it cannot change or reuse.
 */
export interface VaultRequestArgs {
  boxId: number;
  action: number;
  to: string;
  price: string;
  endTime: number;
  handle: string;
  inputProof: string;
}

export interface VaultFinalizeArgs {
  requestId: number;
  cleartexts: string;
  proof: string;
}

export class VaultRelay {
  constructor(
    private readonly base: string,
    readonly address: string,
  ) {}

  /** The relayer of `apiUrl`, or null when that API has none (or is down). */
  static async find(apiUrl: string): Promise<VaultRelay | null> {
    const base = apiUrl.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/v1/vault/relayer`);
      if (!res.ok) return null;
      // The API wraps its answers: { block, data }.
      const { data } = (await res.json()) as { data?: { address?: string | null } };
      return data?.address ? new VaultRelay(base, data.address) : null;
    } catch {
      return null;
    }
  }

  /** Sends the request. Returns the transaction hash. */
  request(args: VaultRequestArgs): Promise<string> {
    return this.post("request", args);
  }

  /** Sends the proof. Returns the transaction hash. */
  finalize(args: VaultFinalizeArgs): Promise<string> {
    return this.post("finalize", args);
  }

  private async post(call: "request" | "finalize", args: VaultRequestArgs | VaultFinalizeArgs): Promise<string> {
    const res = await fetch(`${this.base}/v1/vault/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ call, args }),
    });
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
    if (!res.ok || !body.hash) throw new Error(body.error ?? `The vault relayer answered ${res.status}.`);
    return body.hash;
  }
}
