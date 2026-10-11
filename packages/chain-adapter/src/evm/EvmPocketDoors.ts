import { Contract, getAddress, solidityPackedKeccak256, Wallet, type ContractTransactionResponse, type EventLog, type InterfaceAbi } from "ethers";
import { ChainError, type ActionOptions, type Address, type TxRecord } from "../types";
import type { PocketDoorsAdapter, PocketDoorsInfo, PocketOptions, PocketToken, SideAddress } from "../vault";
import type { EvmPocketsTools } from "./EvmPockets";
import {
  formatStealthMeta,
  parseStealthMeta,
  parseStealthMetadata,
  stealthAddressFor,
  stealthKeyFor,
  stealthKeysFrom,
  stealthMetaOf,
  stealthMetadata,
  STEALTH_SCHEME,
  type StealthKeys,
} from "./stealth";

const ANNOUNCER_ABI = [
  "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)",
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
];
const REGISTRY_ABI = [
  "function registerKeys(uint256 schemeId, bytes stealthMetaAddress)",
  "function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)",
];
const TOKEN_ABI = [
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function setOperator(address operator, uint48 until)",
  "function wrap(address to, uint256 amount)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"];

const ZERO = "0x" + "0".repeat(64);
const LOG_SPAN = 40_000;
/** Gas a collect spends at most: an approve, a wrap, a setOperator and a deposit into a full group. */
const COLLECT_GAS = 2_600_000n;
/** How many entry addresses are looked at before giving up on finding one's key. */
const ENTRY_LOOKBACK = 64;
const OPERATOR_DAYS = 365;


/** What the doors borrow from the pockets they open: the pocket, its set, its signature and the token. */
export interface PocketDoorsSide {
  pockets: { address: string; abi: InterfaceAbi; deployBlock?: number | null };
  token: PocketToken;
  tokenAddress(): Promise<string>;
  /** The pocket signature the keys derive from. */
  signature(opts?: ActionOptions): Promise<string>;
  mine(opts?: ActionOptions): Promise<number>;
  set(real: number, opts?: PocketOptions): Promise<number[]>;
  /** Takes `amount` out of the wallet's pocket to `to`, relayed or not, as the pockets do. */
  withdraw(to: Address, amount: bigint, opts?: PocketOptions): Promise<void>;
  /** Waits for the RPC to see the page's last transaction. */
  caughtUp(): Promise<void>;
}

/**
 * The pockets' doors on an EVM chain: stealth exits (ERC-5564, scheme 1) and entry addresses. The
 * spending and viewing keys, like the entry addresses' keys, come from the pocket signature the
 * wallet gives once a session (`stealth-spend`, `stealth-view`, `entry:<i>`): nothing is stored,
 * and the same wallet finds its meta-address, its inbox and its entry address on any device.
 * A side address acts as itself, with the ETH it was given; its inputs are encrypted with the
 * wallet's permit (the page's credits) for that address as the contract's caller.
 */
export class EvmPocketDoors implements PocketDoorsAdapter {
  private readonly announcer: Contract;
  private readonly registry: Contract;
  private keys: { account: Address; stealth: StealthKeys; signature: string } | null = null;
  /** Stealth addresses found for the wallet, with their keys: what `collect` spends from. */
  private readonly found = new Map<string, string>();

  constructor(
    private readonly stealth: { announcer: string; registry: string },
    private readonly side: PocketDoorsSide,
    private readonly t: EvmPocketsTools,
  ) {
    this.announcer = new Contract(stealth.announcer, ANNOUNCER_ABI, t.readProvider);
    this.registry = new Contract(stealth.registry, REGISTRY_ABI, t.readProvider);
  }

  async info(): Promise<PocketDoorsInfo> {
    const [relay, gasNeeded] = await Promise.all([this.t.relay(), this.gasNeeded()]);
    return { announcer: getAddress(this.stealth.announcer) as Address, registry: getAddress(this.stealth.registry) as Address, gasNeeded, fuel: relay?.fuel ?? null };
  }

  async metaAddress(opts?: ActionOptions): Promise<string> {
    return formatStealthMeta(stealthMetaOf((await this.stealthKeys(opts)).stealth));
  }

  async published(opts?: ActionOptions): Promise<boolean> {
    const account = await this.t.account();
    const mine = await this.metaAddress(opts);
    const stored = String(await this.t.reading(this.registry.stealthMetaAddressOf!(account, STEALTH_SCHEME)));
    return stored.toLowerCase() === mine.replace(/^st:eth:/, "").toLowerCase();
  }

  async publish(opts?: ActionOptions): Promise<void> {
    const mine = await this.metaAddress(opts);
    await this.t.send(opts, () => this.t.writer({ address: this.stealth.registry, abi: REGISTRY_ABI }).registerKeys!(STEALTH_SCHEME, mine.replace(/^st:eth:/, "")));
  }

  async resolve(text: string): Promise<string | null> {
    const typed = parseStealthMeta(text);
    if (typed) return formatStealthMeta(typed);
    const t = text.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return null;
    const stored = String(await this.t.reading(this.registry.stealthMetaAddressOf!(t, STEALTH_SCHEME)));
    const parsed = stored && stored !== "0x" ? parseStealthMeta(stored) : null;
    return parsed ? formatStealthMeta(parsed) : null;
  }

  async withdrawStealth(amount: bigint, to?: string | null, opts?: PocketOptions): Promise<Address> {
    const meta = to ? parseStealthMeta((await this.resolve(to)) ?? "") : stealthMetaOf((await this.stealthKeys(opts)).stealth);
    if (!meta) throw new ChainError("unknown", "That is neither a stealth meta-address nor a wallet that published one.");
    const payment = stealthAddressFor(meta);
    const address = getAddress(payment.address) as Address;
    await this.side.withdraw(address, amount, opts);
    // The announcement, after the payment: the payee's page finds the address by it.
    const metadata = stealthMetadata(payment.viewTag, await this.side.tokenAddress());
    const relay = await this.t.relay();
    if (relay) {
      await this.t.relayed(opts, "announce", () => relay.pockets("stealthAnnounce", { stealthAddress: address, ephemeralPubKey: payment.ephemeralPub, metadata }));
    } else {
      await this.t.send(opts, () => this.t.writer({ address: this.stealth.announcer, abi: ANNOUNCER_ABI }).announce!(STEALTH_SCHEME, address, payment.ephemeralPub, metadata));
    }
    if (!to) this.found.set(address.toLowerCase(), stealthKeyFor((await this.stealthKeys(opts)).stealth, payment)!);
    return address;
  }

  async inbox(opts?: ActionOptions): Promise<SideAddress[]> {
    const { stealth } = await this.stealthKeys(opts);
    const account = await this.t.account();
    const relay = await this.t.relay();
    await this.side.caughtUp();
    // Announcements this page's relayer or this wallet sent: ours are among them, and the scan
    // stays small. A payment announced by another sender (another app's relayer) is not seen here.
    const callers = [...new Set([account, ...(relay ? [relay.address] : [])].map((a) => getAddress(a)))];
    const logs = await this.logs(this.announcer, this.announcer.filters.Announcement!(STEALTH_SCHEME, null, callers), this.side.pockets.deployBlock);
    const token = (await this.side.tokenAddress()).toLowerCase();
    const mine: { address: string; block: number }[] = [];
    for (const l of logs.reverse()) {
      const { stealthAddress, ephemeralPubKey, metadata } = (l as EventLog).args;
      const meta = parseStealthMetadata(String(metadata));
      if (meta.token && meta.token.toLowerCase() !== token) continue;
      const address = String(stealthAddress).toLowerCase();
      if (this.found.has(address)) {
        if (!mine.some((m) => m.address === address)) mine.push({ address, block: l.blockNumber });
        continue;
      }
      const key = stealthKeyFor(stealth, { address, ephemeralPub: String(ephemeralPubKey), viewTag: meta.viewTag });
      if (!key) continue;
      this.found.set(address, key);
      mine.push({ address, block: l.blockNumber });
    }
    return Promise.all(mine.map((m) => this.detail(getAddress(m.address) as Address, "stealth", opts, { block: m.block })));
  }

  async entry(opts?: ActionOptions): Promise<SideAddress> {
    const { index, wallet } = await this.freshEntry(opts);
    return this.detail(wallet.address as Address, "entry", opts, { index });
  }

  async collect(address: Address, opts?: PocketOptions): Promise<void> {
    const wallet = await this.sideWallet(address, opts);
    const who = getAddress(address) as Address;
    const account = await this.t.account();
    const id = await this.side.mine(opts);
    const set = await this.side.set(id, opts);
    const tokenAddress = await this.side.tokenAddress();
    const token = new Contract(tokenAddress, TOKEN_ABI, wallet);
    const plain = new Contract(this.side.token.underlying.address, ERC20_ABI, wallet);

    const [gas, held, needed] = await Promise.all([this.t.readProvider.getBalance(who), this.plainOf(who), this.gasNeeded()]);
    if (gas < needed) throw new ChainError("insufficient-funds", "This address has no ETH for its transactions.", undefined, { held: gas, needed });

    // The plain token first, wrapped into the confidential one, as the deposit form does.
    if (held > 0n) {
      if (BigInt(await this.t.reading(plain.allowance!(who, tokenAddress))) < held) await this.sideSend(opts, "approve", () => plain.approve!(tokenAddress, held));
      await this.sideSend(opts, "wrap", () => token.wrap!(who, held));
    }
    await this.side.caughtUp();
    const sealed = await this.sealedOf(who, wallet, opts);
    if (sealed === 0n) throw new ChainError("unpaid", "This address holds nothing to collect.");
    if (!(await this.t.reading(token.isOperator!(who, this.side.pockets.address)))) {
      // From the chain's clock, not the page's: a local network may run far ahead of it.
      const now = (await this.t.readProvider.getBlock("latest"))?.timestamp ?? Math.floor(Date.now() / 1000);
      await this.sideSend(opts, "setOperator", () => token.setOperator!(this.side.pockets.address, now + OPERATOR_DAYS * 86_400));
    }
    // Encrypted with the wallet's permit, for the side address as the pockets' caller.
    const input = await this.t.encrypt(this.side.pockets.address, account, (b) => b.add32(id).add64(sealed), "the amount", opts, who);
    const pockets = new Contract(this.side.pockets.address, this.side.pockets.abi, wallet);
    await this.sideSend(opts, "deposit", () => pockets.deposit!(set, input.handles[0], input.handles[1], input.inputProof));
  }

  async fuel(address: Address, opts?: ActionOptions): Promise<void> {
    const relay = await this.t.relay();
    if (!relay?.fuel) throw new ChainError("unknown", "The relayer gives no gas on this network: send a little ETH to the address yourself.");
    await this.t.relayed(opts, "fuel", () => relay.pockets("fuel", { to: getAddress(address) }));
  }

  // --- internals ---

  /** ETH a collect needs at today's gas price, with room for a fee bump. */
  private async gasNeeded(): Promise<bigint> {
    const fee = await this.t.readProvider.getFeeData();
    const price = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n;
    return (COLLECT_GAS * price * 12n) / 10n;
  }

  private async stealthKeys(opts?: ActionOptions) {
    const account = await this.t.account();
    if (this.keys?.account !== account) {
      const signature = await this.side.signature(opts);
      this.keys = { account, stealth: stealthKeysFrom(signature), signature };
      this.found.clear();
    }
    return this.keys;
  }

  /** Entry address `i`: a key from the signature and the index, so the wallet finds it again anywhere. */
  private async entryWallet(i: number, opts?: ActionOptions): Promise<Wallet> {
    const { signature } = await this.stealthKeys(opts);
    return new Wallet(solidityPackedKeccak256(["bytes", "string"], [signature, `entry:${i}`]), this.t.readProvider);
  }

  /** The first entry address that never sent a transaction: used ones emptied themselves into the pocket. */
  private async freshEntry(opts?: ActionOptions): Promise<{ index: number; wallet: Wallet }> {
    for (let i = 0; i < ENTRY_LOOKBACK; i++) {
      const wallet = await this.entryWallet(i, opts);
      if ((await this.t.readProvider.getTransactionCount(wallet.address)) === 0) return { index: i, wallet };
    }
    throw new ChainError("unknown", "Every entry address has been used.");
  }

  /** The side address's wallet: a stealth address found in the inbox, or one of the entry addresses. */
  private async sideWallet(address: Address, opts?: ActionOptions): Promise<Wallet> {
    const key = this.found.get(address.toLowerCase()) ?? (await this.inbox(opts), this.found.get(address.toLowerCase()));
    if (key) return new Wallet(key, this.t.readProvider);
    for (let i = 0; i < ENTRY_LOOKBACK; i++) {
      const wallet = await this.entryWallet(i, opts);
      if (wallet.address.toLowerCase() === address.toLowerCase()) return wallet;
    }
    throw new ChainError("not-yours", "This page holds no key for that address.");
  }

  private async detail(address: Address, kind: SideAddress["kind"], opts?: ActionOptions, more: { index?: number; block?: number } = {}): Promise<SideAddress> {
    const wallet = kind === "entry" ? await this.entryWallet(more.index!, opts) : new Wallet(this.found.get(address.toLowerCase())!, this.t.readProvider);
    const [sealed, plain, gas, needed] = await Promise.all([this.sealedOf(address, wallet, opts), this.plainOf(address), this.t.readProvider.getBalance(address), this.gasNeeded()]);
    return { address, kind, sealed, plain, gas, fueled: gas >= needed, ...more };
  }

  /** The side address's confidential balance, decrypted with its own key (the token lets a holder read its balance). */
  private async sealedOf(address: Address, wallet: Wallet, opts?: ActionOptions): Promise<bigint> {
    const tokenAddress = await this.side.tokenAddress();
    const handle = String(await this.t.reading(new Contract(tokenAddress, TOKEN_ABI, this.t.readProvider).confidentialBalanceOf!(address)));
    if (handle === ZERO) return 0n;
    const clear = await this.t.userDecryptAs(wallet, [handle], tokenAddress, opts);
    return BigInt(clear[handle] as bigint);
  }

  private async plainOf(address: Address): Promise<bigint> {
    if (!this.side.token.underlying.address) return 0n;
    return BigInt(await this.t.reading(new Contract(this.side.token.underlying.address, ERC20_ABI, this.t.readProvider).balanceOf!(address)));
  }

  /** A transaction the side address sends itself, told like the page's others (steps and records). */
  private async sideSend(opts: ActionOptions | undefined, call: string, send: () => Promise<ContractTransactionResponse>) {
    opts?.onStep?.("confirming");
    let tx: ContractTransactionResponse;
    try {
      tx = await send();
    } catch (error) {
      throw new ChainError("reverted", `The address could not send ${call}: ${(error as Error).message}`);
    }
    const record: TxRecord = { hash: tx.hash, call, status: "sent", url: this.t.explorerUrl ? `${this.t.explorerUrl}/tx/${tx.hash}` : null };
    opts?.onTx?.(record);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      opts?.onTx?.({ ...record, status: "failed" });
      throw new ChainError("reverted", `${call} failed on-chain.`);
    }
    opts?.onTx?.({ ...record, status: "confirmed", block: receipt.blockNumber, gasUsed: receipt.gasUsed });
    return receipt;
  }

  private async logs(contract: Contract, filter: Parameters<Contract["queryFilter"]>[0], from?: number | null) {
    const latest = await this.t.readProvider.getBlockNumber();
    const out = [];
    for (let start = from ?? 0; start <= latest; start += LOG_SPAN) out.push(...(await contract.queryFilter(filter, start, Math.min(latest, start + LOG_SPAN - 1))));
    return out;
  }
}

