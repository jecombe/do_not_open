/**
 * The API's vault relayer: it sends a holder's request (and its proof) from its own wallet, so
 * the holder's address appears in no transaction. It only ever sees what any observer of the
 * chain would see once the transaction is sent: the box, the action, its terms, and a key
 * encrypted for the vault and bound to those terms, which it cannot change or reuse. It sends the
 * pockets' opens and spends, and the desk's purchases, the same way.
 */
export interface VaultRequestArgs {
  boxId: number;
  action: number;
  to: string;
  price: string;
  endTime: number;
  /** Accepting an offer: its Seaport order hash. */
  ref: string;
  handle: string;
  inputProof: string;
}

export interface VaultFinalizeArgs {
  requestId: number;
  cleartexts: string;
  proof: string;
  /** Accepting an offer: abi.encode(AdvancedOrder, bytes32[] criteriaProof), sent with `finalizeOffer`. */
  offer?: string;
}

/** A pocket spend's encrypted inputs, as `SealedPockets.SpendInput`. */
export interface PocketSpendInput {
  amount: string;
  target: string;
  inputProof: string;
  boundKey: string;
  keyProof: string;
}

/** What the relayer sends for the pockets and their desk, by call. */
export interface PocketRelayCalls {
  /** `pockets`: another token's pockets contract; the cUSDC ones when left out. */
  pocketOpen: { handle: string; inputProof: string; viewer: string; pockets?: string };
  pocketSend: { from: number[]; to: number[]; input: PocketSpendInput; pockets?: string };
  pocketWithdraw: { from: number[]; to: string; input: PocketSpendInput; pockets?: string };
  deskAsk: { saleId: number; handle: string; keyProof: string; boxKey: string };
  deskBuy: { askId: number; cleartexts: string; proof: string; boxKey: string; boxKeyProof: string };
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

  /** Sends a pocket's open or spend, or a desk purchase. Returns the transaction hash. */
  pockets<C extends keyof PocketRelayCalls>(call: C, args: PocketRelayCalls[C]): Promise<string> {
    return this.post(call, args);
  }

  private async post(call: string, args: unknown): Promise<string> {
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
