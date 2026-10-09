import { Contract, getAddress, hexlify, solidityPackedKeccak256, Wallet, type EventLog, type InterfaceAbi } from "ethers";
import { DEFAULT_POCKET_DECOYS, pocketSet } from "../pockets";
import { ChainError, type ActionOptions, type Address } from "../types";
import type { PocketOptions, PocketSale, PocketsAdapter, PocketsInfo, VaultBox, VaultSaleStatus } from "../vault";
import type { ContractTransactionReceipt } from "ethers";
import type { EvmVaultTools } from "./EvmVault";

/** The vault's tools, with its way of sending through the relayer. */
export type EvmPocketsTools = EvmVaultTools & {
  relayed(opts: ActionOptions | undefined, call: string, sendIt: () => Promise<string>, announce?: boolean): Promise<ContractTransactionReceipt>;
};

interface Deployed {
  address: string;
  abi: InterfaceAbi;
  deployBlock?: number | null;
}

/** The pockets, as `dno:export` writes them inside the vault's deployment. */
export interface PocketsDeployment extends Deployed {
  desk: Deployed;
}

/** What the pockets borrow from the vault next to them: its contract, its boxes and its box keys. */
export interface PocketsVaultSide {
  vault: Deployed;
  box(boxId: number): Promise<VaultBox>;
  keyFor(collection: string, tokenId: bigint, opts?: ActionOptions): Promise<bigint>;
}

const SPEND = { send: 0, withdraw: 1 } as const;
const SALE_STATUS: (VaultSaleStatus | "none")[] = ["none", "open", "settled", "cancelled"];
const ASK_DONE = 2;
const ZERO = "0x" + "0".repeat(64);
const LOG_SPAN = 40_000;

const hex = (v: string | Uint8Array) => (typeof v === "string" ? v : hexlify(v));
const isTrue = (v: unknown) => v === true || v === 1n || v === "true";

/** What the wallet signs, once a session, to make its pocket's key and viewer. Free and off-chain. */
export const pocketKeyMessage = (pockets: string, chainId: number) =>
  `DO NOT OPEN pocket key\n\nThis signature makes the key to your pocket in the vault and the address that reads its balance. Anyone who has it can spend your pocket: sign it only on DO NOT OPEN.\n\nPockets: ${pockets}\nChain: ${chainId}`;

/**
 * The connected wallet's pocket on an EVM chain. Its key and its viewer (a wallet that only signs
 * decryption permits, never a transaction) both come from one signature: nothing is stored, and
 * the same wallet finds the same pocket on any device. Spends go through the vault's relayer when
 * the API has one, so the wallet's address is on none of them.
 */
export class EvmPockets implements PocketsAdapter {
  private readonly read: Contract;
  private readonly desk: Contract;
  private readonly vaultRead: Contract;
  private secret: { account: Address; key: bigint; viewer: Wallet } | null = null;

  constructor(
    private readonly deployed: PocketsDeployment,
    private readonly side: PocketsVaultSide,
    private readonly t: EvmPocketsTools,
  ) {
    this.read = new Contract(deployed.address, deployed.abi, t.readProvider);
    this.desk = new Contract(deployed.desk.address, deployed.desk.abi, t.readProvider);
    this.vaultRead = new Contract(side.vault.address, side.vault.abi, t.readProvider);
  }

  async info(): Promise<PocketsInfo> {
    const [count, maxSet] = await Promise.all([this.t.reading(this.read.pocketCount!()), this.t.reading(this.read.MAX_SET!())]);
    return { address: this.deployed.address, desk: this.deployed.desk.address, count: Number(count), maxSet: Number(maxSet) };
  }

  async mine(opts?: ActionOptions): Promise<number | null> {
    const { viewer } = await this.keys(opts);
    const plusOne = Number(await this.t.reading(this.read.pocketOf!(viewer.address)));
    return plusOne === 0 ? null : plusOne - 1;
  }

  async open(opts?: ActionOptions): Promise<number> {
    const had = await this.mine(opts);
    if (had !== null) return had;
    const account = await this.t.account();
    const { key, viewer } = await this.keys(opts);
    const relay = await this.t.relay();
    const input = await this.t.encrypt(this.deployed.address, account, (b) => b.add256(key), "the pocket key", opts, relay?.address ?? account);
    const [handle, inputProof] = [hex(input.handles[0]!), hex(input.inputProof)];
    if (relay) await this.relayed(opts, "open", () => relay.pockets("pocketOpen", { handle, inputProof, viewer: viewer.address }));
    else await this.t.send(opts, () => this.t.writer(this.deployed).open!(handle, inputProof, viewer.address));
    const id = await this.mine(opts);
    if (id === null) throw new ChainError("network", "The pocket did not open.");
    return id;
  }

  async balance(opts?: ActionOptions): Promise<bigint> {
    const id = await this.mineOrThrow(opts);
    const handle = String(await this.t.reading(this.read.balanceOf!(id)));
    if (handle === ZERO) return 0n;
    const { viewer } = await this.keys(opts);
    const clear = await this.t.userDecryptAs(viewer, [handle], this.deployed.address, opts);
    return BigInt(clear[handle] as bigint);
  }

  async deposit(amount: bigint, opts?: PocketOptions & { to?: number }): Promise<void> {
    const account = await this.t.account();
    const to = opts?.to ?? (await this.mineOrThrow(opts));
    const set = await this.set(to, opts);
    await this.t.ensureOperator(await this.t.cUsdc(), account, this.deployed.address, opts);
    const input = await this.t.encrypt(this.deployed.address, account, (b) => b.add32(to).add64(amount), "the amount", opts);
    await this.t.send(opts, () => this.t.writer(this.deployed).deposit!(set, input.handles[0], input.handles[1], input.inputProof));
  }

  async send(to: number, amount: bigint, opts?: PocketOptions): Promise<void> {
    const id = await this.mineOrThrow(opts);
    const from = await this.set(id, opts);
    const toSet = await this.set(to, opts);
    await this.spend(SPEND.send, from, toSet, null, amount, to, opts);
  }

  async withdraw(to: Address, amount: bigint, opts?: PocketOptions): Promise<void> {
    const id = await this.mineOrThrow(opts);
    const from = await this.set(id, opts);
    await this.spend(SPEND.withdraw, from, [], getAddress(to), amount, null, opts);
  }

  async offerSale(boxId: number, pocketId: number, price: bigint, opts?: ActionOptions): Promise<number> {
    const account = await this.t.account();
    // A pocket that does not exist would only fail at the second step.
    await this.t.reading(this.read.viewerOf!(pocketId)).catch(() => {
      throw new ChainError("unknown", `There is no pocket ${pocketId}.`);
    });
    const input = await this.t.encrypt(this.side.vault.address, account, (b) => b.add64(price), "the price", opts);
    const receipt = await this.t.send(opts, () => this.t.writer(this.side.vault).offerSale!(boxId, this.deployed.desk.address, input.handles[0], input.inputProof));
    const log = receipt.logs.map((l) => this.parse(this.vaultRead, l)).find((e) => e?.name === "SaleOffered");
    const saleId = Number(log!.args.saleId);
    await this.t.send(opts, () => this.t.writer(this.deployed.desk).reserve!(saleId, pocketId));
    return saleId;
  }

  async sales(): Promise<PocketSale[]> {
    if (!this.secret) return [];
    const id = await this.mine();
    if (id === null) return [];
    const logs = await this.logs(this.desk, this.desk.filters.Reserved!(null, id), this.deployed.desk.deployBlock);
    const ids = [...new Set(logs.map((l) => Number((l as EventLog).args.saleId)))].sort((a, b) => b - a);
    const rows = await Promise.all(
      ids.map(async (saleId) => ({ saleId, s: await this.t.reading(this.vaultRead.saleInfo!(saleId)), r: Number(await this.t.reading(this.desk.reservedFor!(saleId))) })),
    );
    return rows
      .filter(({ r }) => r === id + 1)
      .map(({ saleId, s }) => ({
        saleId,
        boxId: Number(s.boxId),
        seller: String(s.seller),
        buyer: String(s.buyer),
        status: SALE_STATUS[Number(s.status)] as VaultSaleStatus,
        pocketId: id,
      }));
  }

  async salePrices(saleIds: number[], opts?: ActionOptions): Promise<Record<number, bigint>> {
    const rows = await Promise.all(saleIds.map(async (saleId) => ({ saleId, handle: String((await this.t.reading(this.vaultRead.saleInfo!(saleId))).price) })));
    const readable = rows.filter((r) => r.handle !== ZERO);
    if (!readable.length) return {};
    const { viewer } = await this.keys(opts);
    const clear = await this.t.userDecryptAs(viewer, readable.map((r) => r.handle), this.side.vault.address, opts);
    return Object.fromEntries(readable.map((r) => [r.saleId, BigInt(clear[r.handle] as bigint)]));
  }

  async buy(saleId: number, opts?: ActionOptions): Promise<boolean> {
    const account = await this.t.account();
    const id = await this.mineOrThrow(opts);
    if (Number(await this.t.reading(this.desk.reservedFor!(saleId))) !== id + 1) throw new ChainError("not-yours", "This sale is not reserved for your pocket.");
    const sale = await this.t.reading(this.vaultRead.saleInfo!(saleId));
    const box = await this.side.box(Number(sale.boxId));
    const { key, viewer } = await this.keys(opts);
    const relay = await this.t.relay();
    const sender = relay?.address ?? account;

    // The box's new vault key, encrypted for the vault with the desk as its user; then the
    // pocket's key, bound to the sale, the pocket and that box key.
    const boxKey = await this.side.keyFor(box.collection, box.tokenId, opts);
    const boxInput = await this.t.encrypt(this.side.vault.address, account, (b) => b.add256(boxKey), "the box key", opts, this.deployed.desk.address);
    const boxHandle = hex(boxInput.handles[0]!);
    const hash = BigInt(await this.t.reading(this.desk.buyHash!(saleId, id, boxHandle)));
    const bound = await this.t.encrypt(this.deployed.desk.address, account, (b) => b.add256(key ^ hash), "the pocket key", opts, sender);
    const [handle, keyProof] = [hex(bound.handles[0]!), hex(bound.inputProof)];

    const receipt = relay
      ? await this.relayed(opts, "ask", () => relay.pockets("deskAsk", { saleId, handle, keyProof, boxKey: boxHandle }))
      : await this.t.send(opts, () => this.t.writer(this.deployed.desk).ask!(saleId, handle, keyProof, boxHandle));
    const asked = receipt.logs.map((l) => this.parse(this.desk, l)).find((e) => e?.name === "Asked");
    const askId = Number(asked!.args.askId);

    const { ok } = await this.t.reading(this.desk.askInfo!(askId));
    const decrypted = await this.t.publicDecrypt([String(ok)], opts);
    opts?.onStep?.("proving");
    const args = { askId, cleartexts: decrypted.abiEncodedClearValues, proof: decrypted.decryptionProof, boxKey: boxHandle, boxKeyProof: hex(boxInput.inputProof) };
    if (relay) await this.relayed(opts, "buy", () => relay.pockets("deskBuy", args), false);
    else await this.t.send(opts, () => this.t.writer(this.deployed.desk).buy!(askId, args.cleartexts, args.proof, args.boxKey, args.boxKeyProof));
    if (Number((await this.t.reading(this.desk.askInfo!(askId))).status) !== ASK_DONE) {
      throw new ChainError("not-yours", "Your pocket's key did not match, or it does not cover the price. Nothing happened; the sale is still open.");
    }
    const moved = String((await this.t.reading(this.vaultRead.saleInfo!(saleId))).moved);
    const clear = await this.t.userDecryptAs(viewer, [moved], this.side.vault.address, opts);
    return isTrue(clear[moved]);
  }

  async boxes(): Promise<number[]> {
    if (!this.secret) return [];
    const id = await this.mine();
    if (id === null) return [];
    const logs = await this.logs(this.desk, this.desk.filters.Bought!(null, null, id), this.deployed.desk.deployBlock);
    const boxIds = [...new Set(logs.map((l) => Number((l as EventLog).args.boxId)))];
    if (!boxIds.length) return [];
    const handles = await Promise.all(boxIds.map(async (b) => String(await this.t.reading(this.desk.ownerOf!(b)))));
    const readable = handles.filter((h) => h !== ZERO);
    const clear = readable.length ? await this.t.userDecryptAs(this.secret.viewer, readable, this.deployed.desk.address) : {};
    const mine = boxIds.filter((_, i) => handles[i] !== ZERO && BigInt(clear[handles[i]!] as bigint) === BigInt(id + 1));
    const states = await Promise.all(mine.map(async (b) => (await this.side.box(b)).state));
    return mine.filter((_, i) => states[i] !== "withdrawn" && states[i] !== "claimed").sort((a, b) => a - b);
  }

  // --- internals ---

  /** The pocket's key and viewer, from one signature a session. */
  private async keys(opts?: ActionOptions): Promise<{ key: bigint; viewer: Wallet }> {
    const account = await this.t.account();
    if (this.secret?.account !== account) {
      opts?.onStep?.("wallet");
      const signature = await this.t.signText(pocketKeyMessage(this.deployed.address, this.t.chainId));
      const key = BigInt(solidityPackedKeccak256(["bytes", "string"], [signature, "key"]));
      const viewer = new Wallet(solidityPackedKeccak256(["bytes", "string"], [signature, "viewer"]));
      this.secret = { account, key, viewer };
    }
    return this.secret;
  }

  private async mineOrThrow(opts?: ActionOptions): Promise<number> {
    const id = await this.mine(opts);
    if (id === null) throw new ChainError("not-yours", "Open your pocket first.");
    return id;
  }

  private async set(real: number, opts?: PocketOptions): Promise<number[]> {
    const { count, maxSet } = await this.info();
    return pocketSet(real, count, opts?.decoys ?? DEFAULT_POCKET_DECOYS, maxSet);
  }

  /** A spend: the amount and target, then the key bound to their handles, relayed when there is a relayer. */
  private async spend(action: number, from: number[], to: number[], dest: Address | null, amount: bigint, target: number | null, opts?: ActionOptions): Promise<void> {
    const account = await this.t.account();
    const { key } = await this.keys(opts);
    const relay = await this.t.relay();
    const sender = relay?.address ?? account;
    const values = await this.t.encrypt(this.deployed.address, account, (b) => (target === null ? b.add64(amount) : b.add64(amount).add32(target)), "the amount", opts, sender);
    const amountHandle = hex(values.handles[0]!);
    const targetHandle = target === null ? ZERO : hex(values.handles[1]!);
    const zeroAddress = "0x" + "0".repeat(40);
    const hash = BigInt(await this.t.reading(this.read.spendHash!(action, from, to, dest ?? zeroAddress, amountHandle, target === null ? ZERO : targetHandle)));
    const bound = await this.t.encrypt(this.deployed.address, account, (b) => b.add256(key ^ hash), "the pocket key", opts, sender);
    const input = { amount: amountHandle, target: targetHandle, inputProof: hex(values.inputProof), boundKey: hex(bound.handles[0]!), keyProof: hex(bound.inputProof) };
    if (action === SPEND.send) {
      if (relay) await this.relayed(opts, "send", () => relay.pockets("pocketSend", { from, to, input }));
      else await this.t.send(opts, () => this.t.writer(this.deployed).send!(from, to, input));
    } else {
      if (relay) await this.relayed(opts, "withdraw", () => relay.pockets("pocketWithdraw", { from, to: dest!, input }));
      else await this.t.send(opts, () => this.t.writer(this.deployed).withdraw!(from, dest!, input));
    }
  }

  private relayed(opts: ActionOptions | undefined, call: string, sendIt: () => Promise<string>, announce = true) {
    return this.t.relayed(opts, call, sendIt, announce);
  }

  private parse(contract: Contract, log: { topics: readonly string[]; data: string; address: string }) {
    if (getAddress(log.address) !== getAddress(String(contract.target))) return null;
    try {
      return contract.interface.parseLog(log as never);
    } catch {
      return null;
    }
  }

  private async logs(contract: Contract, filter: Parameters<Contract["queryFilter"]>[0], from?: number | null) {
    const latest = await this.t.readProvider.getBlockNumber();
    const out = [];
    for (let start = from ?? 0; start <= latest; start += LOG_SPAN) {
      out.push(...(await contract.queryFilter(filter, start, Math.min(latest, start + LOG_SPAN - 1))));
    }
    return out;
  }
}
