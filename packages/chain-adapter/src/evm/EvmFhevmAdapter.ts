import {
  Contract,
  Interface,
  isError,
  type ContractTransactionReceipt,
  type ContractTransactionResponse,
  type InterfaceAbi,
  type Provider,
  type Signer,
} from "ethers";
import type { FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import { traitIndexAtOffset } from "../layout";
import {
  ChainError,
  type ActionOptions,
  type Address,
  type AliveCheck,
  type BoxInfo,
  type BoxStatus,
  type BoxSummary,
  type ChainAdapter,
  type CollectionInfo,
  type DuelInfo,
  type DuelResult,
  type DuelStatus,
  type Fees,
  type PairInfo,
  type TraitRoll,
  type TxRecord,
  type WalletOption,
} from "../types";
import type { ChainParams, WalletSource } from "./wallet";

/** The part of the Relayer SDK instance this adapter uses. */
export type Relayer = Pick<FhevmInstance, "generateKeypair" | "createEIP712" | "userDecrypt" | "publicDecrypt">;

export interface EvmAdapterOptions {
  chain: ChainParams;
  /** Address of the DoNotOpen contract. */
  address: string;
  abi: InterfaceAbi;
  /** Reads go here, so the app works before any wallet is connected. */
  readProvider: Provider;
  wallet: WalletSource;
  /** Loads the Relayer SDK (WASM in a browser). Called on the first decryption only. */
  loadRelayer: () => Promise<Relayer>;
}

const BOX_STATUS: BoxStatus[] = ["sealed", "opening", "revealed"];
const ALIVE_CHECK: AliveCheck[] = ["none", "pending", "alive", "notAlive"];
const DUEL_STATUS: DuelStatus[] = ["none", "challenged", "pending", "resolved", "cancelled"];

/** How far back `pair()` looks for a duel that is still open. */
const DUEL_SCAN = 40;
/** `boxesOf()` asks for owners in slices of this many calls. */
const OWNER_SCAN_CHUNK = 100;
/** A user-decryption permit is signed once and reused for this long. */
const PERMIT_DAYS = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Permit {
  account: Address;
  publicKey: string;
  privateKey: string;
  signature: string;
  start: number;
}

/**
 * DO NOT OPEN on an EVM chain running Zama's FHEVM.
 *
 * Every decryption goes through the relayer. Private ones (shake) are re-encrypted for a
 * key made in this session and authorised by an EIP-712 signature. Public ones (open,
 * alive check, duel) come back with a KMS proof that this adapter sends to the contract.
 */
export class EvmFhevmAdapter implements ChainAdapter {
  readonly kind = "evm" as const;

  private readonly contract: Contract;
  private readonly iface: Interface;
  private address_: Address | null = null;
  private readonly listeners = new Set<(account: Address | null) => void>();
  private relayer: Promise<Relayer> | null = null;
  private permit: Permit | null = null;
  private constants: Promise<{ fees: Fees; maxSupply: number; maxPerTx: number }> | null = null;

  constructor(private readonly opts: EvmAdapterOptions) {
    this.iface = new Interface(opts.abi);
    this.contract = new Contract(opts.address, this.iface, opts.readProvider);
    opts.wallet.onChange((signer) => void this.adopt(signer));
    void this.adopt(opts.wallet.current());
  }

  // --- account ---

  account(): Address | null {
    return this.address_;
  }

  wallets(): WalletOption[] {
    return this.opts.wallet.options();
  }

  async connect(walletId?: string): Promise<Address> {
    const signer = await this.opts.wallet.connect(walletId);
    await this.adopt(signer);
    return this.address_!;
  }

  async disconnect(): Promise<void> {
    await this.opts.wallet.disconnect();
    await this.adopt(null);
  }

  onAccountChange(listener: (account: Address | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async adopt(signer: Signer | null): Promise<void> {
    const next = signer ? await signer.getAddress() : null;
    if (next === this.address_) return;
    this.address_ = next;
    this.permit = null;
    for (const l of this.listeners) l(next);
  }

  // --- reads ---

  async collection(): Promise<CollectionInfo> {
    const c = this.contract;
    this.constants ??= Promise.all([c.mintPrice!(), c.observeFee!(), c.feedFee!(), c.paidShakeFee!(), c.maxSupply!(), c.maxPerTx!()]).then(
      ([mint, observe, feed, paidShake, maxSupply, maxPerTx]) => ({
        fees: { mint, observe, feed, paidShake },
        maxSupply: Number(maxSupply),
        maxPerTx: Number(maxPerTx),
      }),
    );
    this.constants.catch(() => (this.constants = null));
    const [constants, totalMinted] = await this.reading(Promise.all([this.constants, c.totalMinted!()]));
    const { chain } = this.opts;
    return {
      chain: chain.name,
      address: this.opts.address,
      explorerUrl: chain.explorerUrl ? `${chain.explorerUrl}/address/${this.opts.address}` : null,
      currency: { symbol: chain.currency.symbol, decimals: chain.currency.decimals },
      ...constants,
      totalMinted: Number(totalMinted),
    };
  }

  async box(tokenId: number): Promise<BoxInfo> {
    const c = this.contract;
    const [owner, status, aliveCheck, partner, wins, feeds, publicTraits, contents] = await this.reading(
      Promise.all([
        c.ownerOf!(tokenId),
        c.status!(tokenId),
        c.aliveCheck!(tokenId),
        c.partnerOf!(tokenId),
        c.wins!(tokenId),
        c.feedCount!(tokenId),
        c.publicTraitsOf!(tokenId),
        c.contentsOf!(tokenId),
      ]),
    );
    const boxStatus = BOX_STATUS[Number(status)]!;
    const mask = Number(publicTraits.mask);
    return {
      tokenId,
      owner,
      status: boxStatus,
      aliveCheck: ALIVE_CHECK[Number(aliveCheck)]!,
      partner: partner.entangled ? Number(partner.partner) : null,
      wins: Number(wins),
      feeds: Number(feeds),
      publicTraits: [...publicTraits.rolls].flatMap((roll: bigint, traitIndex: number) =>
        mask & (1 << traitIndex) ? [{ traitIndex, roll: Number(roll) }] : [],
      ),
      revealed:
        boxStatus === "revealed"
          ? {
              seed: contents.seed,
              state: Number(contents.state),
              traits: [...contents.traits].map(Number),
              score: Number(contents.score),
              affection: Number(contents.affection),
              golden: contents.golden,
            }
          : null,
    };
  }

  /**
   * The contract is a plain ERC-721, without the enumerable extension (it would cost every
   * mint and transfer). So this walks `ownerOf` over the minted range, stopping as soon as
   * the balance is accounted for. Fine for a testnet; a production front end reads an indexer.
   */
  async boxesOf(owner: Address): Promise<number[]> {
    const c = this.contract;
    const [balance, totalMinted] = await this.reading(Promise.all([c.balanceOf!(owner), c.totalMinted!()]));
    const want = Number(balance);
    const found: number[] = [];
    // Newest first: people mostly look at what they just minted.
    for (let hi = Number(totalMinted); hi > 0 && found.length < want; hi -= OWNER_SCAN_CHUNK) {
      const lo = Math.max(0, hi - OWNER_SCAN_CHUNK);
      const ids = Array.from({ length: hi - lo }, (_, i) => lo + i);
      const owners: string[] = await this.reading(Promise.all(ids.map((id) => c.ownerOf!(id))));
      owners.forEach((o, i) => o.toLowerCase() === owner.toLowerCase() && found.push(ids[i]!));
    }
    return found.sort((a, b) => a - b);
  }

  async boxSummaries(from: number, to: number): Promise<BoxSummary[]> {
    const c = this.contract;
    const out: BoxSummary[] = [];
    // Two reads per box, a chunk at a time so a public endpoint is not flooded.
    for (let lo = from; lo < to; lo += OWNER_SCAN_CHUNK) {
      const ids = Array.from({ length: Math.min(OWNER_SCAN_CHUNK, to - lo) }, (_, i) => lo + i);
      const rows = await this.reading(Promise.all(ids.map((id) => Promise.all([c.ownerOf!(id), c.status!(id)]))));
      rows.forEach(([owner, status], i) => out.push({ tokenId: ids[i]!, owner, status: BOX_STATUS[Number(status)]! }));
    }
    return out;
  }

  async pair(tokenA: number, tokenB: number): Promise<PairInfo> {
    const c = this.contract;
    const [count, proposerAB, proposerBA, ownerA, ownerB] = await this.reading(
      Promise.all([c.duelCount!(), c.entangleProposer!(tokenA, tokenB), c.entangleProposer!(tokenB, tokenA), c.ownerOf!(tokenA), c.ownerOf!(tokenB)]),
    );
    const last = Number(count);
    const ids = Array.from({ length: Math.min(DUEL_SCAN, last) }, (_, i) => last - 1 - i);
    const duels: DuelInfo[] = (await this.reading(Promise.all(ids.map((id) => c.duelInfo!(id))))).map((d, i) => ({
      duelId: ids[i]!,
      tokenA: Number(d.tokenIdA),
      tokenB: Number(d.tokenIdB),
      challenger: d.challenger,
      status: DUEL_STATUS[Number(d.duelStatus)]!,
    }));
    const openDuel =
      duels.find(
        (d) =>
          (d.status === "challenged" || d.status === "pending") &&
          ((d.tokenA === tokenA && d.tokenB === tokenB) || (d.tokenA === tokenB && d.tokenB === tokenA)),
      ) ?? null;

    // A proposal is only good while the proposer still holds the box they offered.
    let entangleProposal: PairInfo["entangleProposal"] = null;
    if (BigInt(proposerAB) !== 0n && proposerAB === ownerA) entangleProposal = { from: tokenA, to: tokenB, proposer: proposerAB };
    else if (BigInt(proposerBA) !== 0n && proposerBA === ownerB) entangleProposal = { from: tokenB, to: tokenA, proposer: proposerBA };
    return { openDuel, entangleProposal };
  }

  async credits(owner: Address): Promise<bigint> {
    return this.reading(this.contract.credits!(owner));
  }

  // --- actions ---

  async mint(quantity: number, opts?: ActionOptions): Promise<number[]> {
    const { fees } = await this.collection();
    const receipt = await this.send(opts, (c) => c.mint!(quantity, { value: fees.mint * BigInt(quantity) }));
    return this.events(receipt, "Minted").map((e) => Number(e.tokenId));
  }

  async shake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    await this.send(opts, (c) => c.shake!(tokenId));
    return this.readShake(tokenId, opts);
  }

  async paidShake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    const { fees } = await this.collection();
    await this.send(opts, (c) => c.paidShake!(tokenId, { value: fees.paidShake }));
    return this.readShake(tokenId, opts);
  }

  async feed(tokenId: number, opts?: ActionOptions): Promise<void> {
    const { fees } = await this.collection();
    await this.send(opts, (c) => c.feed!(tokenId, { value: fees.feed }));
  }

  async proveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    await this.send(opts, (c) => c.proveAlive!(tokenId));
    return this.finishProveAlive(tokenId, opts);
  }

  async finishProveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    const handle: string = await this.reading(this.contract.aliveHandle!(tokenId));
    const decrypted = await this.publicDecrypt([handle], opts);
    opts?.onStep?.("proving");
    const receipt = await this.send(opts, (c) => c.finalizeProveAlive!(tokenId, decrypted.abiEncodedClearValues, decrypted.decryptionProof), false);
    return Boolean(this.events(receipt, "AliveProven")[0]?.alive);
  }

  async observe(tokenId: number, opts?: ActionOptions): Promise<BoxInfo[]> {
    const { fees } = await this.collection();
    await this.send(opts, (c) => c.observe!(tokenId, { value: fees.observe }));
    return this.finishObserve(tokenId, opts);
  }

  async finishObserve(tokenId: number, opts?: ActionOptions): Promise<BoxInfo[]> {
    const first = await this.box(tokenId);
    const ids = first.partner === null ? [tokenId] : [tokenId, first.partner];
    for (const id of ids) {
      const box = id === tokenId ? first : await this.box(id);
      if (box.status !== "opening") continue;
      const handles: string[] = [...(await this.reading(this.contract.observeHandles!(id)))];
      const decrypted = await this.publicDecrypt(handles, opts);
      opts?.onStep?.("proving");
      await this.send(opts, (c) => c.finalizeObserve!(id, decrypted.abiEncodedClearValues, decrypted.decryptionProof), false);
    }
    return Promise.all(ids.map((id) => this.box(id)));
  }

  async proposeEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void> {
    await this.send(opts, (c) => c.proposeEntangle!(tokenA, tokenB));
  }

  async acceptEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void> {
    await this.send(opts, (c) => c.acceptEntangle!(tokenA, tokenB));
  }

  async challengeDuel(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<number> {
    const receipt = await this.send(opts, (c) => c.challengeDuel!(tokenA, tokenB));
    return Number(this.events(receipt, "DuelChallenged")[0]!.duelId);
  }

  async cancelDuel(duelId: number, opts?: ActionOptions): Promise<void> {
    await this.send(opts, (c) => c.cancelDuel!(duelId));
  }

  async acceptDuel(duelId: number, opts?: ActionOptions): Promise<void> {
    await this.send(opts, (c) => c.acceptDuel!(duelId));
  }

  async finishDuel(duelId: number, opts?: ActionOptions): Promise<DuelResult> {
    const handles: string[] = [...(await this.reading(this.contract.duelHandles!(duelId)))];
    const decrypted = await this.publicDecrypt(handles, opts);
    opts?.onStep?.("proving");
    const receipt = await this.send(opts, (c) => c.finalizeDuel!(duelId, decrypted.abiEncodedClearValues, decrypted.decryptionProof), false);
    const e = this.events(receipt, "DuelResolved")[0]!;
    return {
      duelId,
      winner: Number(e.winnerTokenId),
      loser: Number(e.loserTokenId),
      shown: { traitIndex: Number(e.revealedTraitIndex), roll: Number(e.revealedTraitRoll) },
    };
  }

  async claim(opts?: ActionOptions): Promise<void> {
    await this.send(opts, (c) => c.claim!());
  }

  // --- internals ---

  private signer(): Signer {
    const signer = this.opts.wallet.current();
    if (!signer) throw new ChainError("not-connected", "Connect a wallet first.");
    return signer;
  }

  /** Sends one transaction and waits until the read provider has seen its block. */
  private async send(
    opts: ActionOptions | undefined,
    call: (contract: Contract) => Promise<ContractTransactionResponse>,
    announce = true,
  ): Promise<ContractTransactionReceipt> {
    const signer = this.signer();
    let sent: TxRecord | null = null;
    try {
      if (announce) opts?.onStep?.("wallet");
      const tx = await call(this.contract.connect(signer) as Contract);
      if (announce) opts?.onStep?.("confirming");
      const explorer = this.opts.chain.explorerUrl;
      sent = { hash: tx.hash, call: this.iface.parseTransaction({ data: tx.data })?.name ?? "?", status: "sent", url: explorer ? `${explorer}/tx/${tx.hash}` : null };
      opts?.onTx?.(sent);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new ChainError("reverted", "The transaction failed on-chain.");
      opts?.onTx?.({ ...sent, status: "confirmed", block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      await this.caughtUp(receipt.blockNumber);
      return receipt;
    } catch (error) {
      if (sent) opts?.onTx?.({ ...sent, status: "failed" });
      throw this.toChainError(error);
    }
  }

  /** Public RPC endpoints sit behind load balancers: a read can land on a node that is a block late. */
  private async caughtUp(blockNumber: number): Promise<void> {
    for (let i = 0; i < 30; i++) {
      if ((await this.opts.readProvider.getBlockNumber()) >= blockNumber) return;
      await sleep(1000);
    }
  }

  private async reading<T>(read: Promise<T>): Promise<T> {
    try {
      return await read;
    } catch (error) {
      throw this.toChainError(error);
    }
  }

  private events(receipt: ContractTransactionReceipt, name: string) {
    return receipt.logs.flatMap((log) => {
      if (log.address.toLowerCase() !== this.opts.address.toLowerCase()) return [];
      const parsed = this.iface.parseLog(log);
      return parsed?.name === name ? [parsed.args] : [];
    });
  }

  private loadRelayer(): Promise<Relayer> {
    this.relayer ??= this.opts.loadRelayer();
    this.relayer.catch(() => (this.relayer = null));
    return this.relayer;
  }

  /**
   * The coprocessor computes ciphertexts a few seconds after the transaction that asked
   * for them, so a decryption requested right away can be told "not ready". Retry a few times.
   */
  private async decrypting<T>(opts: ActionOptions | undefined, run: (relayer: Relayer) => Promise<T>): Promise<T> {
    opts?.onStep?.("decrypting");
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await run(await this.loadRelayer());
      } catch (error) {
        if (error instanceof ChainError || isError(error, "ACTION_REJECTED")) throw this.toChainError(error);
        last = error;
        await sleep(3000 + attempt * 2000);
      }
    }
    throw new ChainError("decryption", `The decryption service did not answer: ${(last as Error)?.message ?? "unknown error"}`);
  }

  private publicDecrypt(handles: string[], opts?: ActionOptions) {
    return this.decrypting(opts, (relayer) => relayer.publicDecrypt(handles));
  }

  /** Decrypts the caller's latest shake of a box: the picked trait and its roll. */
  private async readShake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    const signer = this.signer();
    const account = await signer.getAddress();
    const [pick, roll]: [string, string] = await this.reading(this.contract.lastShake!(tokenId, account));
    const contract = this.opts.address;

    const values = await this.decrypting(opts, async (relayer) => {
      const permit = await this.permitFor(relayer, signer, account, opts);
      return relayer.userDecrypt(
        [
          { handle: pick, contractAddress: contract },
          { handle: roll, contractAddress: contract },
        ],
        permit.privateKey,
        permit.publicKey,
        permit.signature.replace("0x", ""),
        [contract],
        account,
        permit.start,
        PERMIT_DAYS,
      );
    });
    const clear = values as Record<string, bigint | boolean | string>;
    return { traitIndex: traitIndexAtOffset(Number(clear[pick])), roll: Number(clear[roll]) };
  }

  /**
   * One EIP-712 signature lets the relayer re-encrypt, for a key that lives only in this
   * page, whatever the account is already allowed to read on this contract. It is kept in
   * memory so the wallet prompts once per session, not once per shake.
   */
  private async permitFor(relayer: Relayer, signer: Signer, account: Address, opts?: ActionOptions): Promise<Permit> {
    const now = Math.floor(Date.now() / 1000);
    const p = this.permit;
    if (p && p.account === account && now < p.start + PERMIT_DAYS * 86_400 - 600) return p;

    const keypair = relayer.generateKeypair();
    const eip712 = relayer.createEIP712(keypair.publicKey, [this.opts.address], now, PERMIT_DAYS);
    opts?.onStep?.("wallet");
    const signature = await signer.signTypedData(
      eip712.domain as never,
      { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification } as never,
      eip712.message as never,
    );
    opts?.onStep?.("decrypting");
    this.permit = { account, publicKey: keypair.publicKey, privateKey: keypair.privateKey, signature, start: now };
    return this.permit;
  }

  private toChainError(error: unknown): ChainError {
    if (error instanceof ChainError) return error;
    if (isError(error, "ACTION_REJECTED")) return new ChainError("rejected", "The request was declined in the wallet.");
    if (isError(error, "INSUFFICIENT_FUNDS")) return new ChainError("insufficient-funds", "Not enough funds for this transaction.");
    if (isError(error, "CALL_EXCEPTION")) {
      let reason = error.revert?.name;
      if (!reason && error.data && error.data !== "0x") {
        try {
          reason = this.iface.parseError(error.data)?.name;
        } catch {
          // Not one of this contract's errors.
        }
      }
      return new ChainError("reverted", reason ? `The contract refused: ${reason}.` : (error.shortMessage ?? "The contract refused."), reason);
    }
    const e = error as { shortMessage?: string; message?: string; info?: { error?: { code?: number } } };
    if (e.info?.error?.code === 4001) return new ChainError("rejected", "The request was declined in the wallet.");
    return new ChainError("unknown", e.shortMessage ?? e.message ?? "Something went wrong.");
  }
}
