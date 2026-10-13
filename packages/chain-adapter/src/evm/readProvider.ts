import { JsonRpcProvider, type PerformActionRequest } from "ethers";

/**
 * A public read endpoint that sends the event queries it refuses to a second one.
 * Public nodes prune old logs (publicnode keeps about a day and a half of Sepolia's), while the
 * pages read events from a contract's deployment block: those queries go to `historyUrl`.
 */
export class ReadProvider extends JsonRpcProvider {
  private readonly history: JsonRpcProvider | null;

  constructor(url: string, chainId: number, historyUrl?: string | null) {
    super(url, chainId, { staticNetwork: true });
    this.history = historyUrl && historyUrl !== url ? new JsonRpcProvider(historyUrl, chainId, { staticNetwork: true }) : null;
  }

  override async _perform(req: PerformActionRequest): Promise<unknown> {
    try {
      return await super._perform(req);
    } catch (error) {
      if (req.method !== "getLogs" || !this.history) throw error;
      return this.history._perform(req);
    }
  }
}
