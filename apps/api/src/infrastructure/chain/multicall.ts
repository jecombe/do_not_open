import { Interface, type Result } from "ethers";
import type { RpcPool } from "./RpcPool";

/** Multicall3, deployed at the same address on every EVM chain that matters, Sepolia included. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
/** Calls per `eth_call`: well under any gas cap, and under any response size limit. */
const CHUNK = 150;

export interface ViewCall {
  target: string;
  iface: Interface;
  fn: string;
  args: unknown[];
}

/**
 * Many view calls in one `eth_call`, so a sync batch that needs fifty contract reads costs one
 * request. A call that reverts comes back null instead of failing the others. `blockTag` reads
 * the state as of a block, so it can be compared with an index that stopped there.
 */
export async function multicall(rpc: RpcPool, calls: ViewCall[], blockTag: number | "latest" = "latest"): Promise<(Result | null)[]> {
  const out: (Result | null)[] = [];
  for (let i = 0; i < calls.length; i += CHUNK) {
    const chunk = calls.slice(i, i + CHUNK);
    const data = MULTICALL_ABI.encodeFunctionData("aggregate3", [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args) }))]);
    const tag = blockTag === "latest" ? "latest" : `0x${blockTag.toString(16)}`;
    const raw = await rpc.call<string>("eth_call", [{ to: MULTICALL3, data }, tag]);
    const [results] = MULTICALL_ABI.decodeFunctionResult("aggregate3", raw) as unknown as [{ success: boolean; returnData: string }[]];
    results.forEach((r, j) => {
      const c = chunk[j]!;
      if (!r.success) return out.push(null);
      try {
        out.push(c.iface.decodeFunctionResult(c.fn, r.returnData));
      } catch {
        out.push(null);
      }
    });
  }
  return out;
}
