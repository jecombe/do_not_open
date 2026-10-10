import type { Address } from "../../domain/types";

/** A holder's request on a sealed vault box: the key comes encrypted for the vault and the relayer. */
export interface VaultRequestTx {
  boxId: number;
  action: number;
  to: Address;
  price: bigint;
  endTime: number;
  /** Accepting an offer: its Seaport order hash. Zero otherwise. */
  ref: string;
  handle: string;
  inputProof: string;
}

/** The proof that settles a request: anyone may send it. */
export interface VaultFinalizeTx {
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
export interface PositionRange {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
}

/** What funds a position, as `SealedPositions.Funds`: the encrypted amounts and targets, Uniswap's limits. */
export interface PositionFunds {
  set0: number[];
  set1: number[];
  amount0: string;
  amount1: string;
  target0: string;
  target1: string;
  inputProof: string;
  amount0Min: bigint;
  amount1Min: bigint;
  deadline: number;
}

/** Both pocket keys, bound to the funding's terms. */
export interface PositionKeys {
  boundKey0: string;
  boundKey1: string;
  keyProof: string;
}

/** Where a position's tokens go: a set of pockets per side and the encrypted target in each. */
export interface PositionOut {
  set0: number[];
  set1: number[];
  target0: string;
  target1: string;
  inputProof: string;
}

/** The pockets', the desk's and the positions' calls the relayer sends, by name. */
export interface PocketTxs {
  /** Opens a pocket: its key encrypted for the pockets, and the address that reads its balance.
   *  `pockets` names another token's pockets contract (cUSDT, cWETH, cZAMA); the cUSDC ones when left out. */
  pocketOpen: { handle: string; inputProof: string; viewer: Address; pockets?: Address };
  pocketSend: { from: number[]; to: number[]; input: PocketSpendInput; pockets?: Address };
  pocketWithdraw: { from: number[]; to: Address; input: PocketSpendInput; pockets?: Address };
  /** Step 1 of a purchase out of a pocket: the pocket's bound key, and the box key's handle. */
  deskAsk: { saleId: number; handle: string; keyProof: string; boxKey: string };
  /** Step 2: the proof of the "ok" bit and the box's new key. */
  deskBuy: { askId: number; cleartexts: string; proof: string; boxKey: string; boxKeyProof: string };
  /** Opens a Uniswap position out of pockets: keys bound to every term, so the relayer can change none. */
  positionOpen: { range: PositionRange; controller: Address; funds: PositionFunds; keys: PositionKeys };
  positionAdd: { positionId: number; funds: PositionFunds; keys: PositionKeys };
  /** The unwraps' proofs, one per side: anyone may send them. */
  positionSettle: { fundingId: number; clear0: bigint; proof0: string; clear1: bigint; proof1: string };
  /** A holder's actions, signed by the position's controller. */
  positionCollect: { positionId: number; out: PositionOut; deadline: number; signature: string };
  positionDecrease: { positionId: number; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; out: PositionOut; deadline: number; signature: string };
  positionGive: { positionId: number; to: Address; deadline: number; signature: string };
  positionTakeOut: { positionId: number; to: Address; deadline: number; signature: string };
}
export type PocketCall = keyof PocketTxs;

/** Sends the vault's transactions from the relayer's own wallet. */
export interface VaultSender {
  readonly address: Address;
  /** Plays it first: a transaction the vault would refuse is never sent (it throws `VaultRelayRefused`). Returns the hash. */
  request(tx: VaultRequestTx): Promise<string>;
  finalize(tx: VaultFinalizeTx): Promise<string>;
  /** The pockets', the desk's and the positions' calls; refused (`reverted`) where they are not deployed. */
  pockets<C extends PocketCall>(call: C, tx: PocketTxs[C]): Promise<string>;
  /** The wallet's balance in wei, for the monitoring: it pays every transaction's gas. */
  balance?(): Promise<bigint>;
}
