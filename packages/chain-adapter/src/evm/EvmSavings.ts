import { Contract, hexlify, type EventLog, type InterfaceAbi, type Wallet } from "ethers";
import type { ActionOptions, Address } from "../types";
import type { PocketOptions, PocketSavingsAdapter, SavingsInfo, SavingsPending, SavingsShare, SavingsSide, SavingsWindow, SavingsWindowState } from "../vault";
import type { EvmPocketsTools, PocketTokenDeployment } from "./EvmPockets";

interface Deployed {
  address: string;
  abi: InterfaceAbi;
  deployBlock?: number | null;
}

/** The savings, as `dno:export` writes them inside the cUSDC pockets' deployment. */
export interface SavingsDeployment extends Deployed {
  depositBatcher: string;
  redeemBatcher: string;
  /** The Morpho vault (ERC-4626) behind the batchers. */
  vault: string;
  minBatchAge: number;
  /** The vault's confidential shares (Zama's cShare). */
  share: PocketTokenDeployment;
}

/** What the savings borrow from the pockets they serve: the wallet's pocket, its key and its sets. */
export interface SavingsPocketSide {
  pockets: Deployed;
  mine(opts?: ActionOptions): Promise<number>;
  keys(opts?: ActionOptions): Promise<{ key: bigint; viewer: Wallet }>;
  set(real: number, opts?: PocketOptions): Promise<number[]>;
  relayed(opts: ActionOptions | undefined, call: string, sendIt: () => Promise<string>): Promise<{ blockNumber: number }>;
  sent(opts: ActionOptions | undefined, call: () => Promise<{ wait(): Promise<{ blockNumber: number } | null> }>): Promise<{ blockNumber: number }>;
  caughtUp(): Promise<void>;
}

const SIDES: SavingsSide[] = ["save", "unsave"];
const STATES: SavingsWindowState[] = ["open", "joined", "settled", "canceled"];
const ZERO = "0x" + "0".repeat(64);
const LOG_SPAN = 40_000;
const VAULT_ABI = ["function convertToAssets(uint256 shares) view returns (uint256)", "function convertToShares(uint256 assets) view returns (uint256)"];

const hex = (v: string | Uint8Array) => (typeof v === "string" ? v : hexlify(v));

/**
 * The wallet's pocket's savings on an EVM chain: `PocketSavings`, in front of Zama's batchers.
 * A save is asked like a pocket send (the amount in one input, the key bound to its handle in
 * another), relayed when there is a relayer; the shares and the pending commitments are read by
 * the pocket's viewer, as its balance is.
 */
export class EvmSavings implements PocketSavingsAdapter {
  readonly share: SavingsShare;
  private readonly read: Contract;
  private readonly vaultRead: Contract;

  constructor(
    private readonly deployed: SavingsDeployment,
    private readonly side: SavingsPocketSide,
    private readonly t: EvmPocketsTools,
  ) {
    const s = deployed.share;
    this.share = { symbol: s.symbol, name: s.name, address: s.address as Address, decimals: s.decimals, rate: BigInt(s.rate), underlying: { ...s.underlying, address: s.underlying.address as Address } };
    this.read = new Contract(deployed.address, deployed.abi, t.readProvider);
    this.vaultRead = new Contract(deployed.vault, VAULT_ABI, t.readProvider);
  }

  async info(): Promise<SavingsInfo> {
    const [saveId, unsaveId] = await Promise.all([this.t.reading(this.read.openWindow!(0)), this.t.reading(this.read.openWindow!(1))]);
    const [save, unsave] = await Promise.all([this.window(Number(saveId)), this.window(Number(unsaveId))]);
    return {
      address: this.deployed.address as Address,
      vault: this.deployed.vault as Address,
      depositBatcher: this.deployed.depositBatcher as Address,
      redeemBatcher: this.deployed.redeemBatcher as Address,
      minBatchAge: this.deployed.minBatchAge,
      open: { save, unsave },
    };
  }

  async shares(opts?: ActionOptions): Promise<bigint> {
    const id = await this.side.mine(opts);
    await this.side.caughtUp();
    const handle = String(await this.t.reading(this.read.sharesOf!(id)));
    if (handle === ZERO) return 0n;
    const { viewer } = await this.side.keys(opts);
    const clear = await this.t.userDecryptAs(viewer, [handle], this.deployed.address, opts);
    return BigInt(clear[handle] as bigint);
  }

  async value(shares: bigint): Promise<bigint> {
    if (shares === 0n) return 0n;
    return BigInt(await this.t.reading(this.vaultRead.convertToAssets!(shares * this.share.rate)));
  }

  async toShares(amount: bigint): Promise<bigint> {
    if (amount === 0n) return 0n;
    return BigInt(await this.t.reading(this.vaultRead.convertToShares!(amount))) / this.share.rate;
  }

  async pending(opts?: ActionOptions): Promise<SavingsPending[]> {
    const id = await this.side.mine(opts);
    await this.side.caughtUp();
    // The windows the pocket was named in: a save or an unsave names its set.
    const windowIds = new Set<number>();
    for (const name of ["Saved", "Unsaved"] as const) {
      for (const l of await this.logs(this.read.filters[name]!(), this.deployed.deployBlock)) {
        const e = l as EventLog;
        if ((e.args.from as bigint[]).map(Number).includes(id)) windowIds.add(Number(e.args.windowId));
      }
    }
    const rows = await Promise.all(
      [...windowIds].sort((a, b) => a - b).map(async (windowId) => ({ windowId, handle: String(await this.t.reading(this.read.committedOf!(windowId, id))) })),
    );
    const live = rows.filter((r) => r.handle !== ZERO);
    if (!live.length) return [];
    const { viewer } = await this.side.keys(opts);
    const clear = await this.t.userDecryptAs(viewer, live.map((r) => r.handle), this.deployed.address, opts);
    const windows = await Promise.all(live.map((r) => this.window(r.windowId)));
    return live.map((r, i) => ({ windowId: r.windowId, side: windows[i]!.side, state: windows[i]!.state, amount: BigInt(clear[r.handle] as bigint) }));
  }

  async save(amount: bigint, opts?: PocketOptions): Promise<void> {
    await this.spend(0, amount, opts);
  }

  async unsave(shares: bigint, opts?: PocketOptions): Promise<void> {
    await this.spend(1, shares, opts);
  }

  // --- internals ---

  private async window(windowId: number): Promise<SavingsWindow> {
    const w = await this.t.reading(this.read.windowInfo!(windowId));
    const state = STATES[Number(w.state)]!;
    return {
      windowId,
      side: SIDES[Number(w.side)]!,
      state,
      batchId: state === "open" ? null : Number(w.batchId),
      rate: state === "settled" ? BigInt(w.rate) : null,
      openedAt: Number(w.openedAt),
      pockets: Number(w.pocketCount),
      left: Number(w.left),
    };
  }

  /** A save (side 0) or an unsave (side 1): the amount, then the key bound to its handle, relayed when there is a relayer. */
  private async spend(side: 0 | 1, amount: bigint, opts?: PocketOptions): Promise<void> {
    const account = await this.t.account();
    const id = await this.side.mine(opts);
    const from = await this.side.set(id, opts);
    const { key } = await this.side.keys(opts);
    const relay = await this.t.relay();
    const sender = relay?.address ?? account;
    const values = await this.t.encrypt(this.deployed.address, account, (b) => b.add64(amount), "the amount", opts, sender);
    const amountHandle = hex(values.handles[0]!);
    const hash = BigInt(await this.t.reading(this.read.saveHash!(side, from, amountHandle)));
    const bound = await this.t.encrypt(this.deployed.address, account, (b) => b.add256(key ^ hash), "the pocket key", opts, sender);
    const input = { amount: amountHandle, inputProof: hex(values.inputProof), boundKey: hex(bound.handles[0]!), keyProof: hex(bound.inputProof) };
    const call = side === 0 ? "pocketSave" : "pocketUnsave";
    if (relay) await this.side.relayed(opts, call, () => relay.pockets(call, { from, input }));
    else {
      const writer = this.t.writer(this.deployed);
      await this.side.sent(opts, () => (side === 0 ? writer.save!(from, input) : writer.unsave!(from, input)));
    }
  }

  private async logs(filter: Parameters<Contract["queryFilter"]>[0], from?: number | null) {
    const latest = await this.t.readProvider.getBlockNumber();
    const out = [];
    for (let start = from ?? 0; start <= latest; start += LOG_SPAN) {
      out.push(...(await this.read.queryFilter(filter, start, Math.min(latest, start + LOG_SPAN - 1))));
    }
    return out;
  }
}
