import type { PublicationCheck } from "../../application/ports/relayer";
import type { ProtocolDeployment } from "./deployment";
import { aclFilterFor, handlesOf } from "./EvmChainSource";
import type { LogFilter, RpcPool } from "./RpcPool";

/**
 * The few blocks the index has not caught up with yet: a request's handles are decrypted
 * seconds after it is mined, before the indexer's next pass. Read from the ACL's logs directly.
 */
export class AclPublications implements PublicationCheck {
  private readonly filter: LogFilter;

  constructor(
    private readonly rpc: RpcPool,
    d: ProtocolDeployment,
    private readonly lookback: number,
  ) {
    this.filter = aclFilterFor(d);
  }

  async recentlyPublished(handles: string[]): Promise<string[]> {
    const wanted = new Set(handles.map((h) => h.toLowerCase()));
    const head = Number(await this.rpc.call<string>("eth_blockNumber", []));
    const found = new Set<string>();
    for (let at = Math.max(0, head - this.lookback); at <= head; ) {
      const got = await this.rpc.getLogs(this.filter, at, head);
      for (const l of got.logs) for (const h of handlesOf(l)) if (wanted.has(h)) found.add(h);
      at = got.to + 1;
    }
    return [...found];
  }
}
