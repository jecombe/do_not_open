import { ChainError } from "./types";

/**
 * A studio job as the Rats contract takes it: the bytes32 the API signed (keccak256 of the job's
 * UUID), passed through as it came in the adoption. Anything else would not match the signature.
 */
export function ratJob(job: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(job)) throw new ChainError("unknown", "Not an adoption's job reference.");
  return job.toLowerCase();
}
