import { Contract, NonceManager, Wallet, type ContractTransactionResponse, type Provider } from "ethers";
import type { SavingsBatch, SavingsChain, SavingsSide, SavingsWindow } from "../../application/ports/savings";
import { revertReason, sendWithFreshNonce } from "./send";

const SAVINGS_ABI = [
  "function windowCount() view returns (uint256)",
  "function openWindow(uint8 side) view returns (uint256)",
  "function lastBatch(uint8 side) view returns (uint256)",
  "function windowInfo(uint256 windowId) view returns (uint8 side, uint8 state, uint256 batchId, uint64 rate, uint256 openedAt, uint256 pocketCount, uint256 left)",
  "function windowPockets(uint256 windowId) view returns (uint256[])",
  "function committedOf(uint256 windowId, uint256 pocketId) view returns (bytes32)",
  "function join(uint8 side)",
  "function settle(uint256 windowId)",
  "function settlePockets(uint256 windowId, uint256[] ids)",
  "error EmptyWindow()",
  "error BatchAlreadyJoined(uint256 batchId)",
  "error NoWindow(uint256 windowId)",
  "error WindowNotJoined(uint256 windowId)",
  "error BatchNotDone(uint256 windowId, uint8 state)",
  "error WindowNotSettled(uint256 windowId)",
  "error NotCommitted(uint256 windowId, uint256 pocketId)",
];

/** Zama's `DepositVaultBatcherConfidential` / `RedeemVaultBatcherConfidential`: the views the keeper times itself on. */
const BATCHER_ABI = [
  "function currentBatchId() view returns (uint256)",
  "function batchState(uint256 batchId) view returns (uint8)",
  "function batchCreatedAt(uint256 batchId) view returns (uint256)",
  "function batchMinBatchAge(uint256 batchId) view returns (uint256)",
  "function paused() view returns (bool)",
];

const ZERO_HANDLE = "0x" + "0".repeat(64);

/**
 * `PocketSavings` and its two batchers over ethers, writing from the relayer's wallet. Reads go
 * to the provider; a write is estimated, sent (a nonce another process took is retried) and
 * awaited mined, so the keeper never sends twice for the same window because the first
 * transaction was still in the pool.
 */
export class EthersSavingsChain implements SavingsChain {
  readonly address: string;
  private readonly signer: NonceManager;
  private readonly read: Contract;
  private readonly write: Contract;
  private readonly batchers: Record<SavingsSide, Contract>;

  constructor(privateKey: string, savings: { address: string; depositBatcher: string; redeemBatcher: string }, provider: Provider) {
    const wallet = new Wallet(privateKey, provider);
    this.address = wallet.address;
    this.signer = new NonceManager(wallet);
    this.read = new Contract(savings.address, SAVINGS_ABI, provider);
    this.write = new Contract(savings.address, SAVINGS_ABI, this.signer);
    this.batchers = { 0: new Contract(savings.depositBatcher, BATCHER_ABI, provider), 1: new Contract(savings.redeemBatcher, BATCHER_ABI, provider) };
  }

  async windowCount(): Promise<number> {
    return Number(await this.read.windowCount!());
  }

  async openWindow(side: SavingsSide): Promise<number> {
    return Number(await this.read.openWindow!(side));
  }

  async lastBatch(side: SavingsSide): Promise<number> {
    return Number(await this.read.lastBatch!(side));
  }

  async windowInfo(windowId: number): Promise<SavingsWindow> {
    const w = await this.read.windowInfo!(windowId);
    return { side: Number(w.side) as SavingsSide, state: Number(w.state), batchId: Number(w.batchId), pocketCount: Number(w.pocketCount), left: Number(w.left) };
  }

  /** A settled pocket's commitment is cleared to the zero handle: what `settlePockets` would refuse as `NotCommitted`. */
  async unsettledPockets(windowId: number): Promise<number[]> {
    const ids = ((await this.read.windowPockets!(windowId)) as bigint[]).map(Number);
    const committed = await Promise.all(ids.map((id) => this.read.committedOf!(windowId, id) as Promise<string>));
    return ids.filter((_, i) => committed[i] !== ZERO_HANDLE);
  }

  async currentBatch(side: SavingsSide): Promise<SavingsBatch> {
    const batcher = this.batchers[side];
    const id = (await batcher.currentBatchId!()) as bigint;
    const [createdAt, minBatchAge, paused] = await Promise.all([batcher.batchCreatedAt!(id), batcher.batchMinBatchAge!(id), batcher.paused!()]);
    return { id: Number(id), createdAt: Number(createdAt), minBatchAge: Number(minBatchAge), paused: Boolean(paused) };
  }

  async batchState(side: SavingsSide, batchId: number): Promise<number> {
    return Number(await this.batchers[side].batchState!(batchId));
  }

  join(side: SavingsSide): Promise<string> {
    return this.send("join", [side]);
  }

  settle(windowId: number): Promise<string> {
    return this.send("settle", [windowId]);
  }

  settlePockets(windowId: number, ids: number[]): Promise<string> {
    return this.send("settlePockets", [windowId, ids]);
  }

  private async send(method: string, args: unknown[]): Promise<string> {
    const fn = this.write.getFunction(method);
    let tx: ContractTransactionResponse;
    try {
      tx = await sendWithFreshNonce(this.signer, () => fn(...args));
    } catch (error) {
      throw new Error(`${method} refused: ${revertReason(error)}`);
    }
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`${method} reverted on-chain (${tx.hash})`);
    return tx.hash;
  }
}
