import { isError, type Interface } from "ethers";
import { ChainError } from "../types";

/**
 * Turns whatever ethers, a wallet or a public endpoint threw into a `ChainError`. Wallets wrap
 * the same few failures in many shapes (EIP-1193 codes, JSON-RPC codes, nested `error.data`,
 * plain English), so this looks at all of them.
 */
export function toChainError(error: unknown, ifaces: readonly Interface[]): ChainError {
  if (error instanceof ChainError) return error;
  const code = walletCode(error);
  const text = messages(error);

  // EIP-1193: 4001 user rejected; 5000 is what WalletConnect wallets send.
  if (isError(error, "ACTION_REJECTED") || code === 4001 || code === 5000 || /user (rejected|denied|cancel)|rejected by user|request reset/i.test(text)) {
    return new ChainError("rejected", "The request was declined in the wallet.");
  }
  if (code === -32002 || /already pending|request of type .* already/i.test(text)) {
    return new ChainError("wallet-busy", "The wallet already has a request waiting. Open it and answer that one first.");
  }
  if (code === 4100) return new ChainError("not-connected", "The wallet has not given this site access to the account.");
  if (code === 4900 || code === 4901 || /network changed|chain ?id .*mismatch|wrong (network|chain)/i.test(text)) {
    return new ChainError("wrong-network", "The wallet is on another network.");
  }
  if (isError(error, "INSUFFICIENT_FUNDS") || /insufficient funds|exceeds balance|not enough (eth|balance|funds)/i.test(text)) {
    return new ChainError("insufficient-funds", "Not enough funds for the gas.");
  }
  if (isError(error, "NONCE_EXPIRED") || isError(error, "REPLACEMENT_UNDERPRICED") || /nonce too (low|high)|invalid nonce|replacement (transaction )?underpriced|already known/i.test(text)) {
    return new ChainError("nonce", "The wallet's account has an earlier transaction in the way.");
  }

  const reason = revertName(error, ifaces);
  if (reason) return new ChainError("reverted", `The contract refused: ${reason}.`, reason);
  if (/out of gas|gas required exceeds|intrinsic gas too low|gas limit reached/i.test(text)) {
    return new ChainError("reverted", "The transaction ran out of gas.", "OutOfGas");
  }
  if (isError(error, "CALL_EXCEPTION")) {
    return new ChainError("reverted", error.shortMessage ?? "The contract refused.", undefined, { mined: !!error.receipt });
  }
  if (
    isError(error, "NETWORK_ERROR") ||
    isError(error, "TIMEOUT") ||
    isError(error, "SERVER_ERROR") ||
    code === 429 ||
    code === -32005 ||
    /failed to fetch|fetch failed|network ?error|timed? ?out|timeout|too many requests|rate.?limit|\b429\b|\b50[234]\b|ECONNRESET|ENOTFOUND|socket hang up|could not coalesce|missing response/i.test(text)
  ) {
    return new ChainError("network", "The network did not answer.");
  }
  const e = error as { shortMessage?: string; message?: string };
  return new ChainError("unknown", e.shortMessage ?? e.message ?? "Something went wrong.");
}

/** The numeric EIP-1193 or JSON-RPC code, wherever the wallet put it. */
function walletCode(error: unknown): number | null {
  for (const e of nested(error)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return null;
}

/** Every message in the error and the errors it wraps, joined. */
function messages(error: unknown): string {
  return nested(error)
    .flatMap((e) => [(e as { shortMessage?: unknown }).shortMessage, (e as { message?: unknown }).message, (e as { reason?: unknown }).reason])
    .filter((m): m is string => typeof m === "string")
    .join(" | ");
}

/** The error, then what it wraps: ethers keeps the wallet's in `info.error` or `error`. */
function nested(error: unknown): object[] {
  const out: object[] = [];
  const walk = (e: unknown, depth: number) => {
    if (!e || typeof e !== "object" || depth > 4 || out.includes(e)) return;
    out.push(e);
    const o = e as { info?: { error?: unknown }; error?: unknown; cause?: unknown; data?: unknown };
    walk(o.info?.error, depth + 1);
    walk(o.error, depth + 1);
    walk(o.cause, depth + 1);
    if (o.data && typeof o.data === "object") walk(o.data, depth + 1);
  };
  walk(error, 0);
  return out;
}

/** The contract's custom error name, from the decoded revert, the raw revert data wherever a
 *  wallet nested it, or a node's "reverted with custom error 'X()'" message. */
function revertName(error: unknown, ifaces: readonly Interface[]): string | undefined {
  const decoded = (error as { revert?: { name?: string } }).revert?.name;
  if (decoded) return decoded;
  for (const e of nested(error)) {
    const data = (e as { data?: unknown }).data;
    if (typeof data !== "string" || !/^0x[0-9a-f]{8}/i.test(data)) continue;
    for (const iface of ifaces) {
      try {
        const name = iface.parseError(data)?.name;
        if (name) return name;
      } catch {
        // Not one of this contract's errors.
      }
    }
  }
  return /custom error '?(\w+)\(/.exec(messages(error))?.[1];
}
