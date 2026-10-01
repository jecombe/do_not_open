import type { Address, RequestKind, RequestStatus } from "./types";

/** An opening, alive check or entanglement: placed on-chain, settled once its proof comes back. */
export interface Request {
  requestId: number;
  kind: RequestKind;
  tokenId: number;
  /** The entangled partner opened with it, or box B of an entanglement. */
  other: number | null;
  requester: Address;
  status: RequestStatus;
  placedBlock: number;
  settledBlock: number | null;
}

export function settle(r: Request, status: Exclude<RequestStatus, "pending">, block: number): Request {
  return r.status !== "pending" ? r : { ...r, status, settledBlock: block };
}
