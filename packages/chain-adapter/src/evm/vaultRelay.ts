/**
 * The API's vault relayer: it sends a holder's request (and its proof) from its own wallet, so
 * the holder's address appears in no transaction. It only ever sees what any observer of the
 * chain would see once the transaction is sent: the box, the action, its terms, and a key
 * encrypted for the vault and bound to those terms, which it cannot change or reuse. It sends the
 * pockets' opens and spends, the desk's purchases, and the liquidity positions' calls the same way.
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

/** A position's pool and range, as `SealedPositions.Range`. */
export interface PositionRangeArgs {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
}

/** What funds a position, as `SealedPositions.Funds`: plain amounts as decimal strings. */
export interface PositionFundsArgs {
  set0: number[];
  set1: number[];
  amount0: string;
  amount1: string;
  target0: string;
  target1: string;
  inputProof: string;
  amount0Min: string;
  amount1Min: string;
  deadline: number;
}

/** Both pocket keys, bound to the funding's terms, as `SealedPositions.Keys`. */
export interface PositionKeysArgs {
  boundKey0: string;
  boundKey1: string;
  keyProof: string;
}

/** Where a position's tokens go, as `SealedPositions.Out`. */
export interface PositionOutArgs {
  set0: number[];
  set1: number[];
  target0: string;
  target1: string;
  inputProof: string;
}

/** What the relayer sends for the pockets and their desk, by call. */
export interface PocketRelayCalls {
  /** `pockets`: another token's pockets contract; the cUSDC ones when left out. */
  pocketOpen: { handle: string; inputProof: string; viewer: string; pockets?: string };
  pocketSend: { from: number[]; to: number[]; input: PocketSpendInput; pockets?: string };
  pocketWithdraw: { from: number[]; to: string; input: PocketSpendInput; pockets?: string };
  deskAsk: { saleId: number; handle: string; keyProof: string; boxKey: string };
  deskBuy: { askId: number; cleartexts: string; proof: string; boxKey: string; boxKeyProof: string };
  /** The liquidity positions: opening and adding are bound to pocket keys, the rest signed by the position's controller. */
  positionOpen: { range: PositionRangeArgs; controller: string; funds: PositionFundsArgs; keys: PositionKeysArgs };
  positionAdd: { positionId: number; funds: PositionFundsArgs; keys: PositionKeysArgs };
  positionSettle: { fundingId: number; clear0: string; proof0: string; clear1: string; proof1: string };
  positionCollect: { positionId: number; out: PositionOutArgs; deadline: number; signature: string };
  positionDecrease: { positionId: number; liquidity: string; amount0Min: string; amount1Min: string; out: PositionOutArgs; deadline: number; signature: string };
  positionGive: { positionId: number; to: string; deadline: number; signature: string };
  positionTakeOut: { positionId: number; to: string; deadline: number; signature: string };
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

  /** Sends a pocket's open or spend, a desk purchase, or a position's call. Returns the transaction hash. */
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
