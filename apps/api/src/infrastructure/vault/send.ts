import { isError, type ContractTransactionResponse, type NonceManager } from "ethers";

/**
 * Sends through a NonceManager shared with other processes (the API replicas and the indexer
 * hold the same relayer key): a nonce another one took is retried with a fresh count, twice at most.
 */
export async function sendWithFreshNonce(signer: NonceManager, send: () => Promise<ContractTransactionResponse>): Promise<ContractTransactionResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt < 2 && (isError(error, "NONCE_EXPIRED") || isError(error, "REPLACEMENT_UNDERPRICED"))) {
        signer.reset();
        continue;
      }
      throw error;
    }
  }
}

/** The contract's reason when a call reverts (its custom error's name, or ethers' reason), the message otherwise. */
export function revertReason(error: unknown): string {
  return isError(error, "CALL_EXCEPTION") ? (error.revert?.name ?? error.reason ?? "refused") : (error as Error).message;
}
