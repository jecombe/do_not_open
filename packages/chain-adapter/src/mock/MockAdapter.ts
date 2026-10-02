import { spec, TRAIT_KEYS } from "@dno/game-spec";
import { buildCatSpec, buildForWeight, fold32, mulberry32, stateDef } from "@dno/generator";
import { duelSettles, duelUnderway, onShelf } from "../duels";
import {
  ChainError,
  sameAddress,
  type ActionOptions,
  type Address,
  type AliveCheck,
  type BoxInfo,
  type BoxPantry,
  type BoxStatus,
  type BoxSummary,
  type ChainAdapter,
  type DecryptionAllowance,
  type CollectionInfo,
  type DuelInfo,
  type DuelResult,
  type PostDuelOptions,
  type EconomyInfo,
  type MintOptions,
  type OpenedCat,
  type PairInfo,
  type PantryDay,
  type PayOptions,
  type PendingRequest,
  type RevealedContents,
  type TradeSide,
  type TraitRoll,
  type TxRecord,
  type WalletOption,
  type WeighIn,
} from "../types";

/** The account the mock signs you in as, and the one that holds the other boxes. */
export const MOCK_YOU: Address = "0x00000000000000000000000000000000000d0c4a";
export const MOCK_NIGHT_SHIFT: Address = "0x000000000000000000000000000000000000beef";

/** One USDC, in its smallest unit. */
const USD = 1_000_000n;
const FEES = { mint: 5n * USD, observe: USD, feed: USD / 2n, paidShake: (5n * USD) / 2n };
const MAX_PER_TX = Number(spec.mechanics.mint?.maxPerTx ?? 10);
const MILESTONES = spec.collection.milestones;
/** What you start the demo with, and what the faucet gives. */
const START_USDC = 100n * USD;
const START_CUSDC = 20n * USD;
const FAUCET = 100n * USD;
/** The ramp: a fixed 2,500 USDC per ETH, less its fee. */
const USDC_PER_ETH = 2_500n * USD;
const RAMP_FEE_BPS = 30n;

interface MockBox {
  /** Encrypted on a real chain. Null for an empty box: a token id nobody bought. */
  owner: Address | null;
  status: BoxStatus;
  aliveCheck: AliveCheck;
  partner: number | null;
  wins: number;
  /** Feeds, paid or not: only drives the mock's draw. */
  feeds: number;
  affection: number;
  /** The holder's share of paid shakes, waiting in the box. */
  earnings: bigint;
  /** Welcome bag and purrs paid into the box, waiting for its holder. */
  stash: bigint;
  shakes: number;
  publicTraits: Map<number, number>;
  revealed: RevealedContents | null;
  /** Croquettes the cat ate in its life. Encrypted on a real chain until it is weighed. */
  weight: bigint;
  /** Who opened it: public on chain, in the opening's event. */
  openedBy: Address | null;
  /** Mock day of the last meal, with that day's meals and croquettes. */
  mealDay: number;
  mealsToday: number;
  eatenToday: bigint;
  /** Mock milliseconds of the last purr; null until the welcome bag is paid. */
  lastPurr: number | null;
  weighIn: WeighIn | null;
}

const ECONOMY = spec.economy;
const BPS = 10_000n;
const allocation = (key: string) => BigInt(ECONOMY.allocation.find((a) => a.key === key)!.amount);
/** Uniswap V2 takes 0.3% of what goes in. */
const swapOut = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint) =>
  (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);

type MockDuel = Omit<DuelInfo, "duelId">;

/** How long a proven duel stays on the shelf, in seconds. */
const DUEL_LIFETIME = Number(spec.mechanics.duel?.lifetimeDays ?? 7) * 86_400;

export interface MockOptions {
  /** Milliseconds each simulated step takes. 0 in tests. */
  latency?: number;
  /** Boxes minted before the app starts: the first ones to you, the rest to the night shift. */
  yours?: number;
  theirs?: number;
  /** How long a purr "day" lasts, in milliseconds. A minute by default, so the demo moves. */
  dayMs?: number;
  /** Stands in for the clock. Tests move it by hand. */
  now?: () => number;
}

/** Stand-in seed. On a real chain this value is encrypted and nobody can compute it. */
export function mockSeedForToken(tokenId: number): bigint {
  const rand = mulberry32(Math.imul(tokenId + 1, 0x2545f491));
  return (BigInt(Math.floor(rand() * 2 ** 32)) << 32n) | BigInt(Math.floor(rand() * 2 ** 32));
}

/**
 * The weigh-in, by the Pantry's rules. The contract draws the tolerance from keccak256 of the
 * seed; the mock stands in with a seeded PRNG, just as deterministic and as unknown before opening.
 */
export function mockWeighIn(weight: bigint, seed: bigint): WeighIn {
  const { sick: s, diseases } = ECONOMY.weight;
  const rand = mulberry32(fold32(seed) ^ 0x5eed7a11);
  const tolerance = BigInt(s.minWeight) + (BigInt(Math.floor(rand() * 2 ** 32)) % BigInt(s.weightSpread));
  const roll = Math.floor(rand() * 65_536);
  const sick = weight >= tolerance;
  return {
    weight,
    build: buildForWeight(weight).key,
    sick,
    disease: sick ? diseases.find((d) => roll < d.rollBelow)!.key : null,
    tolerance,
  };
}

/**
 * The whole game in memory, with the same rules and the same refusals as the contract.
 * Who holds a box is known here, but only the connected account's own boxes are ever told,
 * as on chain. Requests settle in the same call, so none is left pending. The other holder
 * (the night shift) puts two of its boxes on the duel shelf, takes up at once every duel
 * reserved for one of its boxes, and accepts every entanglement, so each flow can be played alone.
 */
export class MockAdapter implements ChainAdapter {
  readonly kind = "mock" as const;

  private me: Address | null = null;
  private readonly boxes: MockBox[] = [];
  private readonly duelList: MockDuel[] = [];
  /** Box id to its duel on the shelf. */
  private readonly listings = new Map<number, number>();
  private readonly proposals = new Map<string, Address>();
  /** Boxes sold: encrypted on a real chain. */
  private sold = 0;
  private milestonesReached = 0;
  /** Plain USDC, public. */
  private readonly usdc = new Map<Address, bigint>();
  /** cUSDC: encrypted on a real chain, readable by its holder only. */
  private readonly cUsdc = new Map<Address, bigint>();
  /** Bumped on every cUSDC move, standing in for the fresh ciphertext a real transfer makes. */
  private readonly cUsdcMoves = new Map<Address, number>();
  private readonly listeners = new Set<(account: Address | null) => void>();
  private readonly latency: number;
  private block = 5_000_000;
  private txCount = 0;
  private readonly dayMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly plain = new Map<Address, bigint>();
  private readonly hidden = new Map<Address, bigint>();
  private reserve = allocation("gameReserve") + allocation("welcomeBags");
  private burnt = 0n;
  /** The treasury's uncollected share of the meals. */
  private treasury = 0n;
  private wrapped = allocation("gameReserve") + allocation("welcomeBags");
  private pool = { croq: allocation("liquidity"), usdc: 4_000n * USD };
  private purrs = 0;

  constructor(opts: MockOptions = {}) {
    this.latency = opts.latency ?? 450;
    this.dayMs = opts.dayMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.usdc.set(MOCK_YOU, START_USDC);
    this.cUsdc.set(MOCK_YOU, START_CUSDC);
    for (let i = 0; i < (opts.yours ?? 3); i++) this.boxes.push(this.newBox(MOCK_YOU));
    for (let i = 0; i < (opts.theirs ?? 3); i++) this.boxes.push(this.newBox(MOCK_NIGHT_SHIFT));
    this.sold = this.boxes.length;
    this.settleMilestones();
    const theirs = this.boxes.flatMap((b, id) => (b.owner === MOCK_NIGHT_SHIFT ? [id] : []));
    for (const id of theirs.slice(0, 2)) {
      this.duelList.push({ tokenA: id, tokenB: null, reserved: false, challenger: MOCK_NIGHT_SHIFT, accepter: null, status: "posted", openUntil: null });
      this.openListing(this.duelList.length - 1);
    }
  }

  // --- account ---

  account(): Address | null {
    return this.me;
  }

  wallets(): WalletOption[] {
    return [];
  }

  async connect(): Promise<Address> {
    this.me = MOCK_YOU;
    for (const l of this.listeners) l(this.me);
    return this.me;
  }

  async disconnect(): Promise<void> {
    this.me = null;
    for (const l of this.listeners) l(null);
  }

  onAccountChange(listener: (account: Address | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- reads ---

  async collection(): Promise<CollectionInfo> {
    const milestones = MILESTONES;
    return {
      chain: "Mock depot",
      address: "in memory",
      explorerUrl: null,
      currency: { symbol: "ETH", decimals: 18 },
      payment: { symbol: "USDC", confidentialSymbol: "cUSDC", decimals: 6, faucet: FAUCET, ramp: { feeBps: Number(RAMP_FEE_BPS) } },
      maxSupply: spec.collection.maxSupply,
      maxPerTx: MAX_PER_TX,
      tokenCount: this.boxes.length,
      sale: { milestones, reached: this.milestonesReached, soldOut: this.milestonesReached >= milestones.length },
      fees: FEES,
    };
  }

  async box(tokenId: number): Promise<BoxInfo> {
    return this.info(tokenId);
  }

  /** Only the connected account can find its boxes, as on chain. */
  async boxesOf(owner: Address): Promise<number[]> {
    if (!this.me || owner !== this.me) return [];
    return this.boxes.flatMap((b, id) => (b.owner === owner ? [id] : []));
  }

  async boxSummaries(from: number, to: number): Promise<BoxSummary[]> {
    return this.boxes
      .slice(from, to)
      .map((b, i) => ({ tokenId: from + i, mine: this.mine(b), status: b.status, partner: b.status === "sealed" ? b.partner : null }));
  }

  async pair(tokenA: number, tokenB: number): Promise<PairInfo> {
    const duels = this.duelList
      .map((d, duelId): DuelInfo => ({ duelId, ...d }))
      .filter((d) => duelSettles(d, tokenA, tokenB, this.seconds()))
      .reverse();
    let entangleProposal: PairInfo["entangleProposal"] = null;
    for (const [from, to] of [[tokenA, tokenB], [tokenB, tokenA]] as const) {
      const proposer = this.proposals.get(`${from}:${to}`);
      if (proposer) entangleProposal = { from, to, proposer };
    }
    return { duels, entangleProposal };
  }

  async duels(query: { account?: Address; tokenIds?: number[]; open?: boolean }): Promise<DuelInfo[]> {
    const tokens = new Set(query.tokenIds ?? []);
    return this.duelList
      .map((d, duelId): DuelInfo => ({ duelId, ...d }))
      .filter((d) => sameAddress(d.challenger, query.account) || sameAddress(d.accepter, query.account) || tokens.has(d.tokenA) || (d.tokenB !== null && tokens.has(d.tokenB)))
      .filter((d) => !query.open || duelUnderway(d, this.seconds()))
      .reverse();
  }

  async duelShelf(): Promise<DuelInfo[]> {
    return this.duelList
      .map((d, duelId): DuelInfo => ({ duelId, ...d }))
      .filter((d) => onShelf(d, this.seconds()))
      .reverse();
  }

  async openedCats(): Promise<OpenedCat[]> {
    return this.boxes.flatMap((b, tokenId) => (b.revealed && b.openedBy ? [{ tokenId, openedBy: b.openedBy, revealed: b.revealed }] : []));
  }

  /** Gas is free in the mock: every account holds a round 1 ETH. */
  async balance(): Promise<bigint> {
    return 10n ** 18n;
  }

  async usdcBalance(owner: Address): Promise<bigint> {
    return this.usdc.get(owner) ?? 0n;
  }

  async confidentialUsdcHandle(owner: Address): Promise<string> {
    return `mock-cusdc:${owner}:${this.cUsdcMoves.get(owner) ?? 0}`;
  }

  async confidentialUsdcBalance(opts?: ActionOptions): Promise<bigint> {
    const me = this.signer();
    opts?.onStep?.("decrypting");
    await this.wait(1);
    return this.cUsdc.get(me) ?? 0n;
  }

  /** Mock requests settle in the same call, so none is ever left waiting. */
  async pendingRequests(): Promise<PendingRequest[]> {
    return [];
  }

  async finishRequest(): Promise<void> {
    throw revert("RequestNotPending");
  }

  async faucetUsdc(opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    await this.send(opts, "mint");
    this.credit(this.usdc, me, FAUCET);
  }

  async shieldUsdc(amount: bigint, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const held = this.usdc.get(me) ?? 0n;
    if (held < amount) throw new ChainError("insufficient-usdc", "Not enough USDC.", undefined, { held, needed: amount });
    await this.send(opts, "wrap");
    this.credit(this.usdc, me, -amount);
    this.credit(this.cUsdc, me, amount);
  }

  async quoteUsdc(coinIn: bigint): Promise<{ usdcOut: bigint; fee: bigint }> {
    const fee = (coinIn * RAMP_FEE_BPS) / 10_000n;
    return { usdcOut: ((coinIn - fee) * USDC_PER_ETH) / 10n ** 18n, fee };
  }

  /** Gas is free in the mock, and so is the ETH: only the USDC side is tracked. */
  async buyUsdc(coinIn: bigint, shield: boolean, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const { usdcOut } = await this.quoteUsdc(coinIn);
    await this.send(opts, "buy");
    this.credit(shield ? this.cUsdc : this.usdc, me, usdcOut);
  }

  /**
   * Gets `amount` ready in cUSDC, as the app does before a paid call: shielded from plain USDC
   * first with `pay: "usdc"`, otherwise checked against the cUSDC balance.
   */
  private async prepay(opts: PayOptions | undefined, amount: bigint): Promise<void> {
    const me = this.signer();
    if (opts?.pay === "usdc") await this.shieldUsdc(amount, opts);
    else if ((this.cUsdc.get(me) ?? 0n) < amount) {
      throw new ChainError("unpaid", "The cUSDC balance does not cover the price.", undefined, { held: this.cUsdc.get(me) ?? 0n, needed: amount });
    }
  }

  /** Pulls `amount` cUSDC: all of it, or nothing. Returns whether it arrived. */
  private pull(who: Address, amount: bigint): boolean {
    if ((this.cUsdc.get(who) ?? 0n) < amount) return false;
    this.credit(this.cUsdc, who, -amount);
    return true;
  }

  // --- actions ---

  async mint(quantity: number, opts?: MintOptions): Promise<number[]> {
    const me = this.signer();
    if (!Number.isInteger(quantity) || quantity < 1) throw revert("InvalidQuantity");
    const ids = Math.min(MAX_PER_TX, Math.max(quantity, opts?.ids ?? MAX_PER_TX));
    await this.prepay(opts, FEES.mint * BigInt(quantity));
    opts?.onStep?.("encrypting");
    await this.wait(0.8);
    await this.send(opts, "mint");
    // As the contract: at most `ids`, all or nothing at the cap, nothing if the price did not arrive.
    let got = Math.min(quantity, ids);
    if (this.sold + got > spec.collection.maxSupply) got = 0;
    if (got && !this.pull(me, FEES.mint * BigInt(got))) got = 0;
    this.sold += got;
    const first = this.boxes.length;
    for (let i = 0; i < ids; i++) this.boxes.push(this.newBox(i < got ? me : null));
    opts?.onStep?.("decrypting");
    await this.wait(1);
    if (this.settleMilestones()) await this.publish(opts, "announceMilestone");
    if (!got) throw new ChainError("unpaid", "No box this time: sold out, or the cUSDC did not cover it. Nothing was taken.");
    return Array.from({ length: got }, (_, i) => first + i);
  }

  async announceMilestone(): Promise<boolean> {
    return false;
  }

  async shake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    await this.send(opts, "shake");
    if (box.owner !== me) {
      await this.decrypting(opts);
      throw notYours();
    }
    return this.decryptShake(tokenId, opts);
  }

  async paidShake(tokenId: number, opts?: PayOptions): Promise<TraitRoll> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    await this.prepay(opts, FEES.paidShake);
    await this.send(opts, "paidShake");
    if (!this.pull(me, FEES.paidShake)) {
      await this.decrypting(opts);
      throw new ChainError("unpaid", "The fee did not go through: the shake showed nothing.");
    }
    box.earnings += (FEES.paidShake * BigInt(Number(spec.mechanics.paidShake?.holderShareBps ?? 7000))) / 10_000n;
    return this.decryptShake(tokenId, opts);
  }

  async feed(tokenId: number, opts?: PayOptions): Promise<void> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    await this.prepay(opts, FEES.feed);
    await this.send(opts, "feed");
    if (!this.pull(me, FEES.feed)) return;
    box.feeds += 1;
    const rand = mulberry32(Math.imul(tokenId + 7, 0x9e3779b1) + box.feeds * 31337);
    box.affection += Math.floor(rand() * (spec.affection.perFeedMax + 1));
  }

  async proveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.aliveCheck !== "none") throw revert("NotSealed");
    await this.send(opts, "proveAlive");
    await this.publish(opts, "finalize");
    if (box.owner !== me) throw notYours();
    const alive = buildCatSpec({ seed: mockSeedForToken(tokenId) }).state === "alive";
    box.aliveCheck = alive ? "alive" : "notAlive";
    return alive;
  }

  /** Mock checks never wait for a proof. */
  async finishProveAlive(tokenId: number): Promise<boolean> {
    return this.get(tokenId).aliveCheck === "alive";
  }

  async observe(tokenId: number, opts?: PayOptions): Promise<BoxInfo[]> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    await this.prepay(opts, FEES.observe);
    await this.send(opts, "observe");
    // Only a holder is charged.
    const ok = box.owner === me && this.pull(me, FEES.observe);
    await this.publish(opts, "finalize");
    if (!ok) throw notYours();
    const ids = box.partner === null ? [tokenId] : [tokenId, box.partner];
    for (const id of ids) {
      const b = this.get(id);
      if (b.status !== "sealed") continue;
      const cat = buildCatSpec({ seed: mockSeedForToken(id), affection: b.affection });
      b.revealed = {
        seed: mockSeedForToken(id),
        state: stateDef(cat.state).id,
        traits: TRAIT_KEYS.map((k) => cat.traits[k].roll),
        score: cat.rarity.score,
        affection: b.affection,
        golden: cat.rarity.golden,
      };
      b.status = "revealed";
      b.openedBy = me;
    }
    return ids.map((id) => this.info(id));
  }

  /** Mock openings never wait for a proof. */
  async finishObserve(tokenId: number): Promise<BoxInfo[]> {
    const box = this.get(tokenId);
    return (box.partner === null ? [tokenId] : [tokenId, box.partner]).map((id) => this.info(id));
  }

  async proposeEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    this.checkEntangleable(tokenA, tokenB);
    await this.send(opts, "proposeEntangle");
    this.proposals.set(`${tokenA}:${tokenB}`, me);
    // The night shift says yes to everything, for the boxes it holds.
    if (this.get(tokenB).owner === MOCK_NIGHT_SHIFT && this.get(tokenA).owner === me) this.entangle(tokenA, tokenB);
  }

  async acceptEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const proposer = this.proposals.get(`${tokenA}:${tokenB}`);
    if (!proposer) throw revert("NoSuchProposal");
    this.checkEntangleable(tokenA, tokenB);
    await this.send(opts, "acceptEntangle");
    await this.publish(opts, "finalize");
    this.proposals.delete(`${tokenA}:${tokenB}`);
    if (this.get(tokenA).owner !== proposer || this.get(tokenB).owner !== me) throw notYours();
    this.entangle(tokenA, tokenB);
  }

  async postDuel(tokenA: number, opts?: PostDuelOptions): Promise<DuelInfo> {
    const me = this.signer();
    this.requireSealed(tokenA);
    const reserved = opts?.reservedFor !== undefined;
    if (reserved) {
      if (opts.reservedFor === tokenA) throw revert("SameBox");
      this.requireSealed(opts.reservedFor!);
    }
    await this.send(opts, "postDuel");
    this.duelList.push({ tokenA, tokenB: reserved ? opts.reservedFor! : null, reserved, challenger: me, accepter: null, status: "posted", openUntil: null });
    const duelId = this.duelList.length - 1;
    await this.finishDuel(duelId, opts);
    const duel = this.duel(duelId);
    if (duel.status === "void") throw notYours();
    // The night shift takes up at once a duel reserved for one of its boxes.
    if (reserved && this.get(duel.tokenB!).owner === MOCK_NIGHT_SHIFT) Object.assign(duel, { status: "pending", accepter: MOCK_NIGHT_SHIFT });
    return { duelId, ...duel };
  }

  async cancelDuel(duelId: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const duel = this.duel(duelId);
    if (duel.status !== "posted" && duel.status !== "open") throw revert("WrongDuelStatus");
    if (duel.challenger !== me) throw revert("NotChallenger");
    await this.send(opts, "cancelDuel");
    this.close(duelId, "cancelled");
  }

  async acceptDuel(duelId: number, tokenB: number, opts?: ActionOptions): Promise<DuelResult | null> {
    const me = this.signer();
    const duel = this.duel(duelId);
    this.requireSealed(tokenB);
    if (duel.status !== "open") throw revert("WrongDuelStatus");
    if (!onShelf(duel, this.seconds())) throw revert("DuelExpired");
    if (tokenB === duel.tokenA) throw revert("SameBox");
    if (duel.reserved && tokenB !== duel.tokenB) throw revert("NotThisBox");
    this.requireSealed(duel.tokenA);
    await this.send(opts, "acceptDuel");
    Object.assign(duel, { status: "pending", tokenB, accepter: me });
    const result = await this.finishDuel(duelId, opts);
    if (this.duel(duelId).status === "open") throw notYours();
    return result;
  }

  async finishDuel(duelId: number, opts?: ActionOptions): Promise<DuelResult | null> {
    const duel = this.duel(duelId);
    if (duel.status !== "posted" && duel.status !== "pending") throw revert("WrongDuelStatus");
    await this.publish(opts, "finalizeDuel");
    if (duel.status === "posted") {
      if (this.get(duel.tokenA).owner === duel.challenger) this.openListing(duelId);
      else duel.status = "void";
      return null;
    }
    // A challenger who no longer holds the box voids the duel; an accepter who does not hold
    // theirs only puts it back on the shelf.
    if (this.get(duel.tokenA).owner !== duel.challenger) {
      this.close(duelId, "void");
      return null;
    }
    const tokenB = duel.tokenB!;
    if (this.get(tokenB).owner !== duel.accepter) {
      Object.assign(duel, { status: "open", accepter: null, tokenB: duel.reserved ? tokenB : null });
      return null;
    }
    const score = (id: number) => buildCatSpec({ seed: mockSeedForToken(id) }).rarity.score;
    // Strictly higher wins; ties go to B.
    const aWins = score(duel.tokenA) > score(tokenB);
    const [winner, loser] = aWins ? [duel.tokenA, tokenB] : [tokenB, duel.tokenA];
    const shown = this.pickTrait(loser, 1000 + duelId);
    this.close(duelId, "resolved");
    this.get(winner).wins += 1;
    this.get(loser).publicTraits.set(shown.traitIndex, shown.roll);
    return { duelId, winner, loser, shown };
  }

  /** A proven posting goes on the shelf, replacing the box's earlier one. */
  private openListing(duelId: number): void {
    const duel = this.duel(duelId);
    const previous = this.listings.get(duel.tokenA);
    if (previous !== undefined) this.duel(previous).status = "cancelled";
    this.listings.set(duel.tokenA, duelId);
    Object.assign(duel, { status: "open", openUntil: Math.floor(this.seconds()) + DUEL_LIFETIME });
  }

  private close(duelId: number, status: "resolved" | "cancelled" | "void"): void {
    const duel = this.duel(duelId);
    duel.status = status;
    if (this.listings.get(duel.tokenA) === duelId) this.listings.delete(duel.tokenA);
  }

  private seconds(): number {
    return this.now() / 1000;
  }

  private requireSealed(tokenId: number): void {
    if (this.get(tokenId).status !== "sealed") throw revert("NotSealed");
  }

  async claimEarnings(tokenIds: number[], opts?: ActionOptions): Promise<bigint> {
    const me = this.signer();
    if (tokenIds.length > 10) throw revert("TooManyBoxes");
    await this.send(opts, "claimEarnings");
    let total = 0n;
    for (const id of tokenIds) {
      const b = this.get(id);
      if (b.owner !== me) continue;
      total += b.earnings;
      b.earnings = 0n;
    }
    this.credit(this.cUsdc, me, total);
    opts?.onStep?.("decrypting");
    await this.wait(1);
    return total;
  }

  async sendBox(tokenId: number, to: Address, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to) || /^0x0{40}$/.test(to)) throw revert("ConfidentialERC721InvalidReceiver");
    const box = this.get(tokenId);
    await this.send(opts, "confidentialTransfer");
    if (box.owner === me) box.owner = to;
  }

  // --- croquettes ---

  async economy(): Promise<EconomyInfo> {
    const purr = ECONOMY.purr;
    return {
      symbol: ECONOMY.token.symbol,
      confidentialSymbol: ECONOMY.token.confidentialSymbol,
      totalSupply: BigInt(ECONOMY.token.totalSupply),
      wrapped: this.wrapped,
      welcomeBag: ECONOMY.welcomeBag.amount,
      purrMaxPerDay: purr.maxPerDay,
      vetMultiplier: purr.vetMultiplier,
      purrMaxDays: purr.maxDays,
      halvings: this.halvings(),
      halvingPeriod: (purr.halvingDays * this.dayMs) / 1000,
      mealsPerDay: ECONOMY.meal.mealsPerDay,
      maxEatenPerDay: BigInt(ECONOMY.meal.maxEatenPerDay),
      mealTreasuryBps: ECONOMY.meal.treasuryBps,
      mealBurnBps: ECONOMY.meal.burnBps,
      maxBoxesPerClaim: 10,
      links: { croq: null, cCroq: null, pantry: null },
      market: { name: "Mock pool", poolUrl: null, appUrl: null, quote: { symbol: "USDC", decimals: 6 }, croqReserve: this.pool.croq, quoteReserve: this.pool.usdc },
    };
  }

  async boxPantry(tokenId: number): Promise<BoxPantry> {
    const b = this.get(tokenId);
    const next = b.lastPurr === null ? this.now() : b.lastPurr + this.dayMs;
    return {
      welcomed: b.lastPurr !== null,
      nextClaimAt: Math.floor(next / 1000),
      weighing: b.weighIn ? "done" : "none",
      weighIn: b.weighIn,
    };
  }

  async croqBalance(owner: Address): Promise<bigint> {
    return this.plain.get(owner) ?? 0n;
  }

  async confidentialBalance(opts?: ActionOptions): Promise<bigint> {
    const me = this.signer();
    opts?.onStep?.("decrypting");
    await this.wait(1);
    return this.hidden.get(me) ?? 0n;
  }

  async claimCroquettes(tokenIds: number[], opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (tokenIds.length === 0 || tokenIds.length > 10) throw revert("InvalidBoxCount");
    const now = this.now();
    const halvings = this.halvings();
    const dues: [MockBox, bigint][] = [];
    for (const id of tokenIds) {
      const b = this.get(id);
      if (b.lastPurr === null) {
        b.lastPurr = now;
        dues.push([b, BigInt(ECONOMY.welcomeBag.amount)]);
        continue;
      }
      let days = Math.floor((now - b.lastPurr) / this.dayMs);
      if (days === 0) continue;
      if (days > ECONOMY.purr.maxDays) {
        days = ECONOMY.purr.maxDays;
        b.lastPurr = now;
      } else b.lastPurr += days * this.dayMs;
      this.purrs += 1;
      const roll = Math.floor(mulberry32(Math.imul(id + 3, 0x51ed27) + this.purrs * 7919)() * (ECONOMY.purr.maxPerDay + 1));
      const factor = days * (b.aliveCheck === "alive" ? ECONOMY.purr.vetMultiplier : 1);
      dues.push([b, BigInt(roll * factor) >> BigInt(Math.min(halvings, 63))]);
    }
    await this.send(opts, "claim");
    // The reserve pays the whole claim into the boxes, or none of it.
    const total = dues.reduce((sum, [, due]) => sum + due, 0n);
    if (total <= this.reserve) {
      this.reserve -= total;
      for (const [b, due] of dues) b.stash += due;
    }
    // Then the caller takes what waits in the boxes they hold.
    for (const id of tokenIds) {
      const b = this.get(id);
      if (b.owner !== me) continue;
      this.credit(this.hidden, me, b.stash);
      b.stash = 0n;
    }
  }

  async feedCroquettes(tokenId: number, amount: bigint, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const box = this.get(tokenId);
    if (box.status !== "sealed") throw revert("NotSealed");
    if (amount < 0n) throw revert("InvalidAmount");
    const today = this.day();
    if (box.mealDay !== today) Object.assign(box, { mealDay: today, mealsToday: 0, eatenToday: 0n });
    opts?.onStep?.("encrypting");
    await this.wait(0.8);
    await this.send(opts, "feed");
    // Like the contract: a meal past the limits, or from someone who does not hold the cat, moves
    // nothing; past the day's allowance the offer is cut down; too little moves nothing.
    const served = box.owner === me && box.mealsToday < ECONOMY.meal.mealsPerDay;
    if (!served) return;
    const room = BigInt(ECONOMY.meal.maxEatenPerDay) - box.eatenToday;
    const capped = amount < room ? amount : room;
    const moved = (this.hidden.get(me) ?? 0n) >= capped ? capped : 0n;
    this.credit(this.hidden, me, -moved);
    const toTreasury = (moved * BigInt(ECONOMY.meal.treasuryBps)) / BPS;
    const toFire = (moved * BigInt(ECONOMY.meal.burnBps)) / BPS;
    this.treasury += toTreasury;
    this.burnt += toFire;
    this.reserve += moved - toTreasury - toFire;
    box.weight += moved;
    box.eatenToday += moved;
    box.mealsToday += 1;
  }

  async pantryDay(tokenId: number, opts?: ActionOptions): Promise<PantryDay> {
    const me = this.signer();
    const box = this.get(tokenId);
    opts?.onStep?.("decrypting");
    await this.wait(1);
    if (box.owner !== me || box.mealDay !== this.day()) return { meals: 0, eaten: 0n };
    return { meals: box.mealsToday, eaten: box.eatenToday };
  }

  async weigh(tokenId: number, opts?: ActionOptions): Promise<WeighIn> {
    this.signer();
    const box = this.get(tokenId);
    if (box.status !== "revealed" || !box.revealed) throw revert("NotRevealed");
    if (box.weighIn) throw revert("AlreadyWeighed");
    await this.send(opts, "weigh");
    if (box.weight > 0n) await this.publish(opts, "finalizeWeigh");
    box.weighIn = mockWeighIn(box.weight, BigInt(box.revealed.seed));
    return box.weighIn;
  }

  async wrap(amount: bigint, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (amount <= 0n || (this.plain.get(me) ?? 0n) < amount) throw revert("ERC20InsufficientBalance");
    await this.send(opts, "wrap");
    this.credit(this.plain, me, -amount);
    this.credit(this.hidden, me, amount);
    this.wrapped += amount;
  }

  async unwrap(amount: bigint, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (amount <= 0n) throw revert("InvalidAmount");
    await this.send(opts, "unwrap");
    // The burn moves what the holder has, or nothing; the decryption tells which.
    const moved = (this.hidden.get(me) ?? 0n) >= amount ? amount : 0n;
    await this.publish(opts, "finalizeUnwrap");
    this.credit(this.hidden, me, -moved);
    this.credit(this.plain, me, moved);
    this.wrapped -= moved;
  }

  async sendCroquettes(to: Address, amount: bigint, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw revert("ERC7984InvalidReceiver");
    await this.send(opts, "confidentialTransfer");
    const moved = (this.hidden.get(me) ?? 0n) >= amount ? amount : 0n;
    this.credit(this.hidden, me, -moved);
    this.credit(this.hidden, to.toLowerCase() === me.toLowerCase() ? me : to, moved);
  }

  async quote(side: TradeSide, amountIn: bigint): Promise<bigint> {
    if (amountIn <= 0n) return 0n;
    return side === "buy" ? swapOut(amountIn, this.pool.usdc, this.pool.croq) : swapOut(amountIn, this.pool.croq, this.pool.usdc);
  }

  async trade(side: TradeSide, amountIn: bigint, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (amountIn <= 0n) throw revert("UniswapV2: INSUFFICIENT_INPUT_AMOUNT");
    if (side === "sell" && (this.plain.get(me) ?? 0n) < amountIn) throw revert("ERC20InsufficientBalance");
    if (side === "buy" && (this.usdc.get(me) ?? 0n) < amountIn) {
      throw new ChainError("insufficient-usdc", "Not enough USDC.", undefined, { held: this.usdc.get(me) ?? 0n, needed: amountIn });
    }
    const out = await this.quote(side, amountIn);
    await this.send(opts, "swapExactTokensForTokens");
    if (side === "buy") {
      this.pool = { usdc: this.pool.usdc + amountIn, croq: this.pool.croq - out };
      this.credit(this.usdc, me, -amountIn);
      this.credit(this.plain, me, out);
    } else {
      this.pool = { croq: this.pool.croq + amountIn, usdc: this.pool.usdc - out };
      this.credit(this.plain, me, -amountIn);
      this.credit(this.usdc, me, out);
    }
  }

  /** The demo has no relayer, so nobody counts its decryptions. */
  async decryptionAllowance(): Promise<DecryptionAllowance | null> {
    return null;
  }

  async buyCredits(_credits: number, _opts?: ActionOptions): Promise<void> {
    throw new ChainError("unknown", "The demo has no decryption credits: its decryptions are free.");
  }

  // --- internals ---

  private newBox(owner: Address | null): MockBox {
    return {
      owner,
      status: "sealed",
      aliveCheck: "none",
      partner: null,
      wins: 0,
      feeds: 0,
      affection: 0,
      earnings: 0n,
      stash: 0n,
      shakes: 0,
      publicTraits: new Map(),
      revealed: null,
      weight: 0n,
      openedBy: null,
      mealDay: -1,
      mealsToday: 0,
      eatenToday: 0n,
      lastPurr: null,
      weighIn: null,
    };
  }

  /** The mock's "UTC day": one per `dayMs`. */
  private day(): number {
    return Math.floor(this.now() / this.dayMs);
  }

  private halvings(): number {
    return Math.floor((this.now() - this.startedAt) / (ECONOMY.purr.halvingDays * this.dayMs));
  }

  private credit(book: Map<Address, bigint>, who: Address, delta: bigint): void {
    book.set(who, (book.get(who) ?? 0n) + delta);
    if (book === this.cUsdc) this.cUsdcMoves.set(who, (this.cUsdcMoves.get(who) ?? 0) + 1);
  }

  private get(tokenId: number): MockBox {
    const box = this.boxes[tokenId];
    if (!box) throw revert("ConfidentialERC721NonexistentToken");
    return box;
  }

  /** Whether the connected account holds a box: the one thing the chain tells it. */
  private mine(box: MockBox): boolean {
    return !!this.me && box.owner === this.me;
  }

  /** Announces every milestone the sold count reached. Returns whether one was. */
  private settleMilestones(): boolean {
    let announced = false;
    while (this.milestonesReached < MILESTONES.length && this.sold >= MILESTONES[this.milestonesReached]!) {
      this.milestonesReached += 1;
      announced = true;
    }
    return announced;
  }

  private sealed(tokenId: number): MockBox {
    const box = this.get(tokenId);
    if (box.status !== "sealed") throw revert("NotSealed");
    return box;
  }

  private duel(duelId: number): MockDuel {
    const duel = this.duelList[duelId];
    if (!duel) throw revert("WrongDuelStatus");
    return duel;
  }

  private signer(): Address {
    if (!this.me) throw new ChainError("not-connected", "No account connected.");
    return this.me;
  }

  private info(tokenId: number): BoxInfo {
    const b = this.get(tokenId);
    return {
      tokenId,
      mine: this.mine(b),
      status: b.status,
      aliveCheck: b.aliveCheck,
      partner: b.partner,
      wins: b.wins,
      publicTraits: [...b.publicTraits].map(([traitIndex, roll]) => ({ traitIndex, roll })),
      revealed: b.revealed,
    };
  }

  private pickTrait(tokenId: number, salt: number): TraitRoll {
    const pick = mulberry32(Math.imul(tokenId + 31, 7919) + salt * 104729);
    const key = TRAIT_KEYS[Math.floor(pick() * TRAIT_KEYS.length)]!;
    const cat = buildCatSpec({ seed: mockSeedForToken(tokenId) });
    return { traitIndex: spec.traits.find((t) => t.key === key)!.index, roll: cat.traits[key].roll };
  }

  private async decryptShake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    const box = this.get(tokenId);
    box.shakes += 1;
    opts?.onStep?.("decrypting");
    await this.wait(1.4);
    return this.pickTrait(tokenId, box.shakes);
  }

  private checkEntangleable(tokenA: number, tokenB: number): void {
    if (tokenA === tokenB) throw revert("SameBox");
    const [a, b] = [this.get(tokenA), this.get(tokenB)];
    if (a.status !== "sealed" || b.status !== "sealed") throw revert("NotSealed");
    if (a.partner !== null || b.partner !== null) throw revert("AlreadyEntangled");
  }

  private entangle(tokenA: number, tokenB: number): void {
    this.proposals.delete(`${tokenA}:${tokenB}`);
    this.get(tokenA).partner = tokenB;
    this.get(tokenB).partner = tokenA;
  }

  /** One transaction: a wallet prompt, then inclusion. */
  private async send(opts: ActionOptions | undefined, call: string, announce = true): Promise<void> {
    if (announce) opts?.onStep?.("wallet");
    await this.wait(0.6);
    if (announce) opts?.onStep?.("confirming");
    const tx: TxRecord = { hash: this.fakeHash(), call, status: "sent", url: null };
    opts?.onTx?.(tx);
    await this.wait(1);
    this.block += 1;
    opts?.onTx?.({ ...tx, status: "confirmed", block: this.block, gasUsed: 90_000n + BigInt(this.block % 7) * 11_000n });
  }

  /** A made-up but well-formed transaction hash. */
  private fakeHash(): string {
    this.txCount += 1;
    const rand = mulberry32(this.txCount * 7907);
    return "0x" + Array.from({ length: 64 }, () => Math.floor(rand() * 16).toString(16)).join("");
  }

  /** A private decryption that comes back empty-handed. */
  private async decrypting(opts: ActionOptions | undefined): Promise<void> {
    opts?.onStep?.("decrypting");
    await this.wait(1.4);
  }

  /** A public decryption followed by the transaction that carries its proof. */
  private async publish(opts: ActionOptions | undefined, call: string): Promise<void> {
    opts?.onStep?.("decrypting");
    await this.wait(1.4);
    opts?.onStep?.("proving");
    await this.send(opts, call, false);
  }

  private wait(factor: number): Promise<void> {
    return this.latency ? new Promise((r) => setTimeout(r, this.latency * factor)) : Promise.resolve();
  }
}

const revert = (reason: string) => new ChainError("reverted", `The depot refused: ${reason}.`, reason);
const notYours = () => new ChainError("not-yours", "This box is not yours. Nothing happened.");
