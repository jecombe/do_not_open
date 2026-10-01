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
  type BoxPantry,
  type BoxStatus,
  type BoxSummary,
  type Build,
  type ChainAdapter,
  type CollectionInfo,
  type DuelInfo,
  type DuelResult,
  type Disease,
  type DuelStatus,
  type EconomyInfo,
  type Fees,
  type PairInfo,
  type TradeSide,
  type TraitRoll,
  type TxRecord,
  type WalletOption,
  type WeighIn,
} from "../types";
import type { ChainParams, WalletSource } from "./wallet";

/** The part of the Relayer SDK instance this adapter uses. */
export type Relayer = Pick<FhevmInstance, "generateKeypair" | "createEIP712" | "userDecrypt" | "publicDecrypt" | "createEncryptedInput">;

interface Deployed {
  address: string;
  abi: InterfaceAbi;
}

/** The croquette economy, as `dno:export` writes it next to the collection's deployment. */
export interface EconomyDeployment {
  croq: Deployed;
  cCroq: Deployed;
  pantry: Deployed;
  /** A Uniswap V2 pool, when one was opened on this network. */
  market: { pair: string; router: string; factory: string; weth: string } | null;
}

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
  /** Without it, every croquette call fails with "not deployed". */
  economy?: EconomyDeployment;
}

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
];
const PAIR_ABI = ["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)", "function token0() view returns (address)"];
/** An operator approval given to the Pantry lasts this long. */
const OPERATOR_DAYS = 365;
/** A trade accepts at most this much less than its quote, in basis points. */
const SLIPPAGE_BPS = 100n;
const ZERO_HANDLE = "0x" + "0".repeat(64);

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
/** Pantry.WeighIn.status, by value. */
const WEIGHING = ["none", "pending", "done"] as const;
const WEIGHED = 2;
const BUILDS: Build[] = ["thin", "normal", "chubby", "fat", "huge"];
const DISEASES: Disease[] = ["diabetic", "arthritic", "fattyLiver"];

function weighInFrom(w: { build: bigint; sick: boolean; disease: bigint; weight: bigint; tolerance: bigint }): WeighIn {
  return {
    weight: BigInt(w.weight),
    build: BUILDS[Number(w.build)]!,
    sick: Boolean(w.sick),
    disease: w.sick ? DISEASES[Number(w.disease)]! : null,
    tolerance: BigInt(w.tolerance),
  };
}

export class EvmFhevmAdapter implements ChainAdapter {
  readonly kind = "evm" as const;

  private readonly contract: Contract;
  private readonly iface: Interface;
  private address_: Address | null = null;
  private readonly listeners = new Set<(account: Address | null) => void>();
  private relayer: Promise<Relayer> | null = null;
  private permit: Permit | null = null;
  private constants: Promise<{ fees: Fees; maxSupply: number; maxPerTx: number }> | null = null;
  private economyConstants: Promise<Omit<EconomyInfo, "wrapped" | "halvings" | "market">> | null = null;
  /** Every contract this adapter may send to, so a receipt can be parsed whichever it hit. */
  private readonly ifaces: Interface[];

  constructor(private readonly opts: EvmAdapterOptions) {
    this.iface = new Interface(opts.abi);
    this.contract = new Contract(opts.address, this.iface, opts.readProvider);
    const e = opts.economy;
    this.ifaces = [this.iface, ...(e ? [e.croq.abi, e.cCroq.abi, e.pantry.abi, ROUTER_ABI].map((abi) => new Interface(abi)) : [])];
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
    // Two reads per box, plus the partner of the sealed ones (only they can still be
    // entangled), a chunk at a time so a public endpoint is not flooded.
    for (let lo = from; lo < to; lo += OWNER_SCAN_CHUNK) {
      const ids = Array.from({ length: Math.min(OWNER_SCAN_CHUNK, to - lo) }, (_, i) => lo + i);
      const rows = await this.reading(Promise.all(ids.map((id) => Promise.all([c.ownerOf!(id), c.status!(id)]))));
      const statuses = rows.map(([, status]) => BOX_STATUS[Number(status)]!);
      const partners = await this.reading(
        Promise.all(ids.map((id, i) => (statuses[i] === "sealed" ? c.partnerOf!(id) : null))),
      );
      rows.forEach(([owner], i) => {
        const p = partners[i];
        out.push({ tokenId: ids[i]!, owner, status: statuses[i]!, partner: p && p[0] ? Number(p[1]) : null });
      });
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

  async balance(owner: Address): Promise<bigint> {
    return this.reading(this.opts.readProvider.getBalance(owner));
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

  // --- croquettes ---

  private eco(): EconomyDeployment {
    const e = this.opts.economy;
    if (!e) throw new ChainError("unknown", "The croquette economy is not deployed on this network.");
    return e;
  }

  private at(deployed: Deployed | string, abi?: InterfaceAbi): Contract {
    return typeof deployed === "string" ? new Contract(deployed, abi!, this.opts.readProvider) : new Contract(deployed.address, deployed.abi, this.opts.readProvider);
  }

  private link(address: string): string | null {
    const explorer = this.opts.chain.explorerUrl;
    return explorer ? `${explorer}/address/${address}` : null;
  }

  async economy(): Promise<EconomyInfo> {
    const e = this.eco();
    const pantry = this.at(e.pantry);
    const croq = this.at(e.croq);
    this.economyConstants ??= Promise.all([
      croq.totalSupply!(),
      pantry.welcomeBag!(),
      pantry.purrMaxPerDay!(),
      pantry.vetMultiplier!(),
      pantry.purrMaxDays!(),
      pantry.halvingPeriod!(),
      pantry.mealsPerDay!(),
      pantry.maxEatenPerDay!(),
      pantry.mealTreasuryBps!(),
      pantry.mealBurnBps!(),
      pantry.maxBoxesPerClaim!(),
    ]).then(([totalSupply, welcomeBag, purrMaxPerDay, vetMultiplier, purrMaxDays, halvingPeriod, mealsPerDay, maxEatenPerDay, mealTreasuryBps, mealBurnBps, maxBoxesPerClaim]) => ({
      symbol: "CROQ",
      confidentialSymbol: "cCROQ",
      totalSupply,
      welcomeBag: Number(welcomeBag),
      purrMaxPerDay: Number(purrMaxPerDay),
      vetMultiplier: Number(vetMultiplier),
      purrMaxDays: Number(purrMaxDays),
      halvingPeriod: Number(halvingPeriod),
      mealsPerDay: Number(mealsPerDay),
      maxEatenPerDay: BigInt(maxEatenPerDay),
      mealTreasuryBps: Number(mealTreasuryBps),
      mealBurnBps: Number(mealBurnBps),
      maxBoxesPerClaim: Number(maxBoxesPerClaim),
      links: { croq: this.link(e.croq.address), cCroq: this.link(e.cCroq.address), pantry: this.link(e.pantry.address) },
    }));
    this.economyConstants.catch(() => (this.economyConstants = null));

    const market = e.market;
    const [constants, wrapped, halvings, reserves, token0] = await this.reading(
      Promise.all([
        this.economyConstants,
        croq.balanceOf!(e.cCroq.address),
        pantry.halvings!(),
        market ? this.at(market.pair, PAIR_ABI).getReserves!() : null,
        market ? this.at(market.pair, PAIR_ABI).token0!() : null,
      ]),
    );
    const croqFirst = token0 && String(token0).toLowerCase() === e.croq.address.toLowerCase();
    return {
      ...constants,
      wrapped,
      halvings: Number(halvings),
      market:
        market && reserves
          ? {
              name: "Uniswap V2",
              poolUrl: this.link(market.pair),
              appUrl: `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=ETH&outputCurrency=${e.croq.address}`,
              croqReserve: croqFirst ? reserves[0] : reserves[1],
              nativeReserve: croqFirst ? reserves[1] : reserves[0],
            }
          : null,
    };
  }

  async boxPantry(tokenId: number): Promise<BoxPantry> {
    const pantry = this.at(this.eco().pantry);
    const [meals, mealsToday, lastPurr, nextClaimAt, w] = await this.reading(
      Promise.all([
        pantry.meals!(tokenId),
        pantry.mealsToday!(tokenId),
        pantry.lastPurr!(tokenId),
        pantry.nextClaimAt!(tokenId),
        pantry.weighIn!(tokenId),
      ]),
    );
    const status = Number(w.status);
    return {
      meals: Number(meals),
      mealsToday: Number(mealsToday),
      welcomed: BigInt(lastPurr) !== 0n,
      nextClaimAt: Number(nextClaimAt),
      weighing: WEIGHING[status] ?? "none",
      weighIn: status === WEIGHED ? weighInFrom(w) : null,
    };
  }

  async croqBalance(owner: Address): Promise<bigint> {
    return this.reading(this.at(this.eco().croq).balanceOf!(owner));
  }

  async confidentialBalance(opts?: ActionOptions): Promise<bigint> {
    const account = await this.signer().getAddress();
    const handle: string = await this.reading(this.at(this.eco().cCroq).confidentialBalanceOf!(account));
    return this.userDecrypt64(handle, this.eco().cCroq.address, opts);
  }

  /** Decrypts a euint64 the connected account is allowed on. A zero handle is 0. */
  private async userDecrypt64(handle: string, contractAddress: string, opts?: ActionOptions): Promise<bigint> {
    if (handle === ZERO_HANDLE) return 0n;
    const signer = this.signer();
    const account = await signer.getAddress();
    const values = await this.decrypting(opts, async (relayer) => {
      const permit = await this.permitFor(relayer, signer, account, opts);
      return relayer.userDecrypt(
        [{ handle, contractAddress }],
        permit.privateKey,
        permit.publicKey,
        permit.signature.replace("0x", ""),
        this.permitContracts(),
        account,
        permit.start,
        PERMIT_DAYS,
      );
    });
    return BigInt((values as Record<string, bigint | boolean | string>)[handle] as bigint);
  }

  async claimCroquettes(tokenIds: number[], opts?: ActionOptions): Promise<void> {
    const pantry = this.eco().pantry;
    await this.send(opts, () => this.writer(pantry).claim!(tokenIds));
  }

  async feedCroquettes(tokenId: number, amount: bigint, opts?: ActionOptions): Promise<void> {
    const e = this.eco();
    const account = await this.signer().getAddress();
    await this.ensureOperator(account, e.pantry.address, opts);
    const input = await this.encrypt64(e.pantry.address, account, amount, opts);
    await this.send(opts, () => this.writer(e.pantry).feed!(tokenId, input.handles[0], input.inputProof));
  }

  async eatenToday(tokenId: number, opts?: ActionOptions): Promise<bigint> {
    const pantry = this.eco().pantry;
    const handle: string = await this.reading(this.at(pantry).eatenTodayHandle!(tokenId));
    return this.userDecrypt64(handle, pantry.address, opts);
  }

  async weigh(tokenId: number, opts?: ActionOptions): Promise<WeighIn> {
    const pantry = this.eco().pantry;
    // A weighing left pending only needs its proof.
    if ((await this.boxPantry(tokenId)).weighing === "none") await this.send(opts, () => this.writer(pantry).weigh!(tokenId));
    const after = await this.boxPantry(tokenId);
    if (after.weighIn) return after.weighIn;
    const handle: string = await this.reading(this.at(pantry).weightHandle!(tokenId));
    const decrypted = await this.publicDecrypt([handle], opts);
    opts?.onStep?.("proving");
    await this.send(opts, () => this.writer(pantry).finalizeWeigh!(tokenId, decrypted.abiEncodedClearValues, decrypted.decryptionProof), false);
    const done = await this.boxPantry(tokenId);
    if (!done.weighIn) throw new ChainError("unknown", "The weigh-in was not recorded.");
    return done.weighIn;
  }

  async wrap(amount: bigint, opts?: ActionOptions): Promise<void> {
    const e = this.eco();
    const account = await this.signer().getAddress();
    await this.ensureAllowance(e.croq, e.cCroq.address, account, amount, opts);
    await this.send(opts, () => this.writer(e.cCroq).wrap!(account, amount));
  }

  async unwrap(amount: bigint, opts?: ActionOptions): Promise<void> {
    const e = this.eco();
    const account = await this.signer().getAddress();
    const input = await this.encrypt64(e.cCroq.address, account, amount, opts);
    const receipt = await this.send(opts, () => this.writer(e.cCroq)["unwrap(address,address,bytes32,bytes)"]!(account, account, input.handles[0], input.inputProof));
    const requested = this.events(receipt, "UnwrapRequested", e.cCroq.address)[0];
    if (!requested) throw new ChainError("unknown", "The unwrap request was not found in the receipt.");
    const requestId: string = requested.unwrapRequestId;
    const decrypted = await this.publicDecrypt([requestId], opts);
    const cleartext = BigInt(decrypted.clearValues[requestId as `0x${string}`] as bigint);
    opts?.onStep?.("proving");
    await this.send(opts, () => this.writer(e.cCroq).finalizeUnwrap!(requestId, cleartext, decrypted.decryptionProof), false);
  }

  async sendCroquettes(to: Address, amount: bigint, opts?: ActionOptions): Promise<void> {
    const e = this.eco();
    const account = await this.signer().getAddress();
    const input = await this.encrypt64(e.cCroq.address, account, amount, opts);
    await this.send(opts, () => this.writer(e.cCroq)["confidentialTransfer(address,bytes32,bytes)"]!(to, input.handles[0], input.inputProof));
  }

  async quote(side: TradeSide, amountIn: bigint): Promise<bigint> {
    const { market, croq } = this.eco();
    if (!market) throw new ChainError("unknown", "There is no market on this network.");
    if (amountIn <= 0n) return 0n;
    const path = side === "buy" ? [market.weth, croq.address] : [croq.address, market.weth];
    const amounts: bigint[] = await this.reading(this.at(market.router, ROUTER_ABI).getAmountsOut!(amountIn, path));
    return amounts[amounts.length - 1]!;
  }

  async trade(side: TradeSide, amountIn: bigint, opts?: ActionOptions): Promise<void> {
    const { market, croq } = this.eco();
    if (!market) throw new ChainError("unknown", "There is no market on this network.");
    const account = await this.signer().getAddress();
    const minOut = ((await this.quote(side, amountIn)) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    const deadline = Math.floor(Date.now() / 1000) + 20 * 60;
    const router = this.writer({ address: market.router, abi: ROUTER_ABI });
    if (side === "buy") {
      await this.send(opts, () => router.swapExactETHForTokens!(minOut, [market.weth, croq.address], account, deadline, { value: amountIn }));
    } else {
      await this.ensureAllowance(croq, market.router, account, amountIn, opts);
      await this.send(opts, () => router.swapExactTokensForETH!(amountIn, minOut, [croq.address, market.weth], account, deadline));
    }
  }

  private writer(deployed: Deployed): Contract {
    return new Contract(deployed.address, deployed.abi, this.signer());
  }

  private async ensureAllowance(token: Deployed, spender: string, account: Address, amount: bigint, opts?: ActionOptions): Promise<void> {
    const allowance: bigint = await this.reading(this.at(token).allowance!(account, spender));
    if (allowance >= amount) return;
    await this.send(opts, () => this.writer(token).approve!(spender, amount));
  }

  /** ERC-7984 has no allowances: the Pantry must be an operator to pull a meal. Asked once a year. */
  private async ensureOperator(account: Address, operator: string, opts?: ActionOptions): Promise<void> {
    const cCroq = this.eco().cCroq;
    if (await this.reading(this.at(cCroq).isOperator!(account, operator))) return;
    const until = Math.floor(Date.now() / 1000) + OPERATOR_DAYS * 86_400;
    await this.send(opts, () => this.writer(cCroq).setOperator!(operator, until));
  }

  /** Encrypts one 64-bit amount, in this page, for `contract` and `account` only. */
  private async encrypt64(contract: string, account: Address, amount: bigint, opts?: ActionOptions) {
    if (amount < 0n || amount >= 1n << 64n) throw new ChainError("unknown", "That amount does not fit.");
    opts?.onStep?.("encrypting");
    try {
      const relayer = await this.loadRelayer();
      return await relayer.createEncryptedInput(contract, account).add64(amount).encrypt();
    } catch (error) {
      throw new ChainError("decryption", `Could not encrypt the amount: ${(error as Error)?.message ?? "unknown error"}`);
    }
  }

  /** Contracts a user-decryption permit covers: the boxes, and with croquettes, cCROQ balances
   *  and what a feeder gave a cat today. */
  private permitContracts(): string[] {
    const e = this.opts.economy;
    return e ? [this.opts.address, e.cCroq.address, e.pantry.address] : [this.opts.address];
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
      sent = { hash: tx.hash, call: this.callName(tx.data), status: "sent", url: explorer ? `${explorer}/tx/${tx.hash}` : null };
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

  private callName(data: string): string {
    for (const iface of this.ifaces) {
      const parsed = iface.parseTransaction({ data });
      if (parsed) return parsed.name;
    }
    return "?";
  }

  private events(receipt: ContractTransactionReceipt, name: string, address: string = this.opts.address) {
    const iface = address === this.opts.address ? this.iface : this.ifaces.find((i) => i.getEvent(name)) ?? this.iface;
    return receipt.logs.flatMap((log) => {
      if (log.address.toLowerCase() !== address.toLowerCase()) return [];
      const parsed = iface.parseLog(log);
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
        this.permitContracts(),
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
    const eip712 = relayer.createEIP712(keypair.publicKey, this.permitContracts(), now, PERMIT_DAYS);
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
        for (const iface of this.ifaces) {
          try {
            reason = iface.parseError(error.data)?.name;
          } catch {
            // Not one of this contract's errors.
          }
          if (reason) break;
        }
      }
      return new ChainError("reverted", reason ? `The contract refused: ${reason}.` : (error.shortMessage ?? "The contract refused."), reason);
    }
    const e = error as { shortMessage?: string; message?: string; info?: { error?: { code?: number } } };
    if (e.info?.error?.code === 4001) return new ChainError("rejected", "The request was declined in the wallet.");
    return new ChainError("unknown", e.shortMessage ?? e.message ?? "Something went wrong.");
  }
}
