import { spec, TRAIT_KEYS } from "@dno/game-spec";
import { buildCatSpec, buildForWeight, fold32, mulberry32, stateDef } from "@dno/generator";
import {
  ChainError,
  type ActionOptions,
  type Address,
  type AliveCheck,
  type BoxInfo,
  type BoxPantry,
  type BoxStatus,
  type BoxSummary,
  type ChainAdapter,
  type CollectionInfo,
  type DuelInfo,
  type DuelResult,
  type DuelStatus,
  type EconomyInfo,
  type PairInfo,
  type Payment,
  type PayOptions,
  type PendingOrder,
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
/** What you start the demo with, and what the faucet gives. */
const START_USDC = 100n * USD;
const START_CUSDC = 20n * USD;
const FAUCET = 100n * USD;
/** The ramp: a fixed 2,500 USDC per ETH, less its fee. */
const USDC_PER_ETH = 2_500n * USD;
const RAMP_FEE_BPS = 30n;

interface MockBox {
  owner: Address;
  status: BoxStatus;
  aliveCheck: AliveCheck;
  partner: number | null;
  wins: number;
  feeds: number;
  affection: number;
  shakes: number;
  publicTraits: Map<number, number>;
  revealed: RevealedContents | null;
  /** Croquettes the cat ate in its life. Encrypted on a real chain until it is weighed. */
  weight: bigint;
  meals: number;
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

interface MockDuel {
  tokenA: number;
  tokenB: number;
  challenger: Address;
  status: DuelStatus;
}

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
 * The other holder (the night shift) accepts every duel and every entanglement at once,
 * so each flow can be played alone.
 */
export class MockAdapter implements ChainAdapter {
  readonly kind = "mock" as const;

  private me: Address | null = null;
  private readonly boxes: MockBox[] = [];
  private readonly duels: MockDuel[] = [];
  private readonly proposals = new Map<string, Address>();
  private readonly owed = new Map<Address, bigint>();
  /** Plain USDC, public. */
  private readonly usdc = new Map<Address, bigint>();
  /** cUSDC: encrypted on a real chain, readable by its holder only. */
  private readonly cUsdc = new Map<Address, bigint>();
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
    return {
      chain: "Mock depot",
      address: "in memory",
      explorerUrl: null,
      currency: { symbol: "ETH", decimals: 18 },
      payment: { symbol: "USDC", confidentialSymbol: "cUSDC", decimals: 6, faucet: FAUCET, ramp: { feeBps: Number(RAMP_FEE_BPS) } },
      maxSupply: spec.collection.maxSupply,
      maxPerTx: Number(spec.mechanics.mint?.maxPerTx ?? 10),
      totalMinted: this.boxes.length,
      fees: FEES,
    };
  }

  async box(tokenId: number): Promise<BoxInfo> {
    return this.info(tokenId);
  }

  async boxesOf(owner: Address): Promise<number[]> {
    return this.boxes.flatMap((b, id) => (b.owner === owner ? [id] : []));
  }

  async boxSummaries(from: number, to: number): Promise<BoxSummary[]> {
    return this.boxes.slice(from, to).map((b, i) => ({ tokenId: from + i, owner: b.owner, status: b.status, partner: b.status === "sealed" ? b.partner : null }));
  }

  async pair(tokenA: number, tokenB: number): Promise<PairInfo> {
    const between = (d: MockDuel) =>
      (d.tokenA === tokenA && d.tokenB === tokenB) || (d.tokenA === tokenB && d.tokenB === tokenA);
    let openDuel: DuelInfo | null = null;
    this.duels.forEach((d, duelId) => {
      if (between(d) && (d.status === "challenged" || d.status === "pending")) openDuel = { duelId, ...d };
    });
    let entangleProposal: PairInfo["entangleProposal"] = null;
    for (const [from, to] of [[tokenA, tokenB], [tokenB, tokenA]] as const) {
      const proposer = this.proposals.get(`${from}:${to}`);
      if (proposer && proposer === this.boxes[from]?.owner) entangleProposal = { from, to, proposer };
    }
    return { openDuel, entangleProposal };
  }

  async credits(owner: Address): Promise<bigint> {
    return this.owed.get(owner) ?? 0n;
  }

  /** Gas is free in the mock: every account holds a round 1 ETH. */
  async balance(): Promise<bigint> {
    return 10n ** 18n;
  }

  async usdcBalance(owner: Address): Promise<bigint> {
    return this.usdc.get(owner) ?? 0n;
  }

  async confidentialUsdcBalance(opts?: ActionOptions): Promise<bigint> {
    const me = this.signer();
    opts?.onStep?.("decrypting");
    await this.wait(1);
    return this.cUsdc.get(me) ?? 0n;
  }

  /** Mock orders settle in the same call, so none is ever left waiting. */
  async pendingOrders(): Promise<PendingOrder[]> {
    return [];
  }

  async finishOrder(): Promise<void> {
    throw revert("OrderNotPending");
  }

  async faucetUsdc(opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    await this.send(opts, "mint");
    this.credit(this.usdc, me, FAUCET);
  }

  async shieldUsdc(amount: bigint, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if ((this.usdc.get(me) ?? 0n) < amount) throw new ChainError("insufficient-usdc", "Not enough USDC.");
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
   * Takes `amount` from the caller, the way the contract would. USDC: refused up front when
   * short. cUSDC: an order, a public decryption of "paid", then the proof; short means
   * nothing moves and the action does not happen.
   */
  private async charge(opts: PayOptions | undefined, amount: bigint, call: string): Promise<void> {
    const me = this.signer();
    const pay: Payment = opts?.pay ?? "usdc";
    if (pay === "usdc") {
      if ((this.usdc.get(me) ?? 0n) < amount) throw new ChainError("insufficient-usdc", "Not enough USDC.");
      await this.send(opts, call);
      this.credit(this.usdc, me, -amount);
      return;
    }
    await this.send(opts, "order");
    await this.publish(opts, "finalizeOrder");
    if ((this.cUsdc.get(me) ?? 0n) < amount) throw new ChainError("unpaid", "The cUSDC balance did not cover the price.");
    this.credit(this.cUsdc, me, -amount);
  }

  // --- actions ---

  async mint(quantity: number, opts?: PayOptions): Promise<number[]> {
    const me = this.signer();
    const max = Number(spec.mechanics.mint?.maxPerTx ?? 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) throw revert("InvalidQuantity");
    if (this.boxes.length + quantity > spec.collection.maxSupply) throw revert("SoldOut");
    await this.charge(opts, FEES.mint * BigInt(quantity), "mint");
    const first = this.boxes.length;
    for (let i = 0; i < quantity; i++) this.boxes.push(this.newBox(me));
    return Array.from({ length: quantity }, (_, i) => first + i);
  }

  async shake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.owner !== me) throw revert("NotHolder");
    await this.send(opts, "shake");
    return this.decryptShake(tokenId, opts);
  }

  async paidShake(tokenId: number, opts?: PayOptions): Promise<TraitRoll> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.owner === me) throw revert("HolderShakesForFree");
    await this.charge(opts, FEES.paidShake, "paidShake");
    const share = (FEES.paidShake * BigInt(Number(spec.mechanics.paidShake?.holderShareBps ?? 7000))) / 10_000n;
    // In USDC the holder is credited and claims; in cUSDC the share arrives at once.
    this.credit(opts?.pay === "cusdc" ? this.cUsdc : this.owed, box.owner, share);
    return this.decryptShake(tokenId, opts);
  }

  async feed(tokenId: number, opts?: PayOptions): Promise<void> {
    this.signer();
    const box = this.sealed(tokenId);
    await this.charge(opts, FEES.feed, "feed");
    box.feeds += 1;
    const rand = mulberry32(Math.imul(tokenId + 7, 0x9e3779b1) + box.feeds * 31337);
    box.affection += Math.floor(rand() * (spec.affection.perFeedMax + 1));
  }

  async proveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.owner !== me) throw revert("NotHolder");
    if (box.aliveCheck !== "none") throw revert("AliveCheckAlreadyRequested");
    await this.send(opts, "proveAlive");
    box.aliveCheck = "pending";
    return this.finishProveAlive(tokenId, opts);
  }

  async finishProveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    const box = this.get(tokenId);
    if (box.aliveCheck !== "pending") throw revert("AliveCheckNotPending");
    await this.publish(opts, "finalizeProveAlive");
    const alive = buildCatSpec({ seed: mockSeedForToken(tokenId) }).state === "alive";
    box.aliveCheck = alive ? "alive" : "notAlive";
    return alive;
  }

  async observe(tokenId: number, opts?: PayOptions): Promise<BoxInfo[]> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.owner !== me) throw revert("NotHolder");
    await this.charge(opts, FEES.observe, "observe");
    box.status = "opening";
    if (box.partner !== null && this.get(box.partner).status === "sealed") this.get(box.partner).status = "opening";
    return this.finishObserve(tokenId, opts);
  }

  async finishObserve(tokenId: number, opts?: ActionOptions): Promise<BoxInfo[]> {
    const box = this.get(tokenId);
    const ids = box.partner === null ? [tokenId] : [tokenId, box.partner];
    if (box.status !== "opening") throw revert("NotObserving");
    for (const id of ids) {
      const b = this.get(id);
      if (b.status !== "opening") continue;
      await this.publish(opts, "finalizeObserve");
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
    }
    return ids.map((id) => this.info(id));
  }

  async proposeEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (this.get(tokenA).owner !== me) throw revert("NotHolder");
    this.checkEntangleable(tokenA, tokenB);
    await this.send(opts, "proposeEntangle");
    this.proposals.set(`${tokenA}:${tokenB}`, me);
    // The night shift says yes to everything.
    if (this.get(tokenB).owner === MOCK_NIGHT_SHIFT) this.entangle(tokenA, tokenB);
  }

  async acceptEntangle(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (this.get(tokenB).owner !== me) throw revert("NotHolder");
    const proposer = this.proposals.get(`${tokenA}:${tokenB}`);
    if (!proposer || proposer !== this.get(tokenA).owner) throw revert("NoSuchProposal");
    this.checkEntangleable(tokenA, tokenB);
    await this.send(opts, "acceptEntangle");
    this.entangle(tokenA, tokenB);
  }

  async challengeDuel(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<number> {
    const me = this.signer();
    if (this.get(tokenA).owner !== me) throw revert("NotHolder");
    if (tokenA === tokenB) throw revert("SameBox");
    if (this.get(tokenA).status !== "sealed" || this.get(tokenB).status !== "sealed") throw revert("NotSealed");
    await this.send(opts, "challengeDuel");
    const duel: MockDuel = { tokenA, tokenB, challenger: me, status: "challenged" };
    this.duels.push(duel);
    if (this.get(tokenB).owner === MOCK_NIGHT_SHIFT) duel.status = "pending";
    return this.duels.length - 1;
  }

  async cancelDuel(duelId: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const duel = this.duel(duelId);
    if (duel.status !== "challenged") throw revert("WrongDuelStatus");
    if (duel.challenger !== me) throw revert("NotHolder");
    await this.send(opts, "cancelDuel");
    duel.status = "cancelled";
  }

  async acceptDuel(duelId: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const duel = this.duel(duelId);
    if (duel.status !== "challenged") throw revert("WrongDuelStatus");
    if (this.get(duel.tokenB).owner !== me) throw revert("NotHolder");
    if (this.get(duel.tokenA).owner !== duel.challenger) throw revert("ChallengerNoLongerHolds");
    await this.send(opts, "acceptDuel");
    duel.status = "pending";
  }

  async finishDuel(duelId: number, opts?: ActionOptions): Promise<DuelResult> {
    const duel = this.duel(duelId);
    if (duel.status !== "pending") throw revert("WrongDuelStatus");
    await this.publish(opts, "finalizeDuel");
    const score = (id: number) => buildCatSpec({ seed: mockSeedForToken(id) }).rarity.score;
    // Strictly higher wins; ties go to B.
    const aWins = score(duel.tokenA) > score(duel.tokenB);
    const [winner, loser] = aWins ? [duel.tokenA, duel.tokenB] : [duel.tokenB, duel.tokenA];
    const shown = this.pickTrait(loser, 1000 + duelId);
    duel.status = "resolved";
    this.get(winner).wins += 1;
    this.get(loser).publicTraits.set(shown.traitIndex, shown.roll);
    return { duelId, winner, loser, shown };
  }

  async claim(opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    if (!this.owed.get(me)) throw revert("NothingToClaim");
    await this.send(opts, "claim");
    this.credit(this.usdc, me, this.owed.get(me)!);
    this.owed.set(me, 0n);
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
      meals: b.meals,
      mealsToday: b.mealDay === this.day() ? b.mealsToday : 0,
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
    let owed = 0n;
    let paid = false;
    const updates: [MockBox, number][] = [];
    for (const id of tokenIds) {
      const b = this.get(id);
      if (b.owner !== me) throw revert("NotHolder");
      if (b.lastPurr === null) {
        updates.push([b, now]);
        owed += BigInt(ECONOMY.welcomeBag.amount);
        paid = true;
        continue;
      }
      let days = Math.floor((now - b.lastPurr) / this.dayMs);
      if (days === 0) continue;
      paid = true;
      if (days > ECONOMY.purr.maxDays) {
        days = ECONOMY.purr.maxDays;
        updates.push([b, now]);
      } else updates.push([b, b.lastPurr + days * this.dayMs]);
      this.purrs += 1;
      const roll = Math.floor(mulberry32(Math.imul(id + 3, 0x51ed27) + this.purrs * 7919)() * (ECONOMY.purr.maxPerDay + 1));
      const factor = days * (b.aliveCheck === "alive" ? ECONOMY.purr.vetMultiplier : 1);
      owed += BigInt(roll * factor) >> BigInt(Math.min(halvings, 63));
    }
    if (!paid) throw revert("NothingToClaim");
    await this.send(opts, "claim");
    for (const [b, at] of updates) b.lastPurr = at;
    const total = owed < this.reserve ? owed : this.reserve;
    this.reserve -= total;
    this.credit(this.hidden, me, total);
  }

  async feedCroquettes(tokenId: number, amount: bigint, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const box = this.get(tokenId);
    if (box.owner !== me) throw revert("NotHolder");
    if (box.status !== "sealed") throw revert("NotSealed");
    const today = this.day();
    if (box.mealDay !== today) Object.assign(box, { mealDay: today, mealsToday: 0, eatenToday: 0n });
    if (box.mealsToday >= ECONOMY.meal.mealsPerDay) throw revert("NoMoreMealsToday");
    if (amount < 0n) throw revert("InvalidAmount");
    await this.send(opts, "feed");
    // Like the contract: past the day's allowance the offer is cut down, too little moves nothing.
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
    box.meals += 1;
  }

  async eatenToday(tokenId: number, opts?: ActionOptions): Promise<bigint> {
    this.signer();
    const box = this.get(tokenId);
    opts?.onStep?.("decrypting");
    await this.wait(1);
    return box.mealDay === this.day() ? box.eatenToday : 0n;
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
    if (side === "buy" && (this.usdc.get(me) ?? 0n) < amountIn) throw new ChainError("insufficient-usdc", "Not enough USDC.");
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

  // --- internals ---

  private newBox(owner: Address): MockBox {
    return {
      owner,
      status: "sealed",
      aliveCheck: "none",
      partner: null,
      wins: 0,
      feeds: 0,
      affection: 0,
      shakes: 0,
      publicTraits: new Map(),
      revealed: null,
      weight: 0n,
      meals: 0,
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
  }

  private get(tokenId: number): MockBox {
    const box = this.boxes[tokenId];
    if (!box) throw revert("ERC721NonexistentToken");
    return box;
  }

  private sealed(tokenId: number): MockBox {
    const box = this.get(tokenId);
    if (box.status !== "sealed") throw revert("NotSealed");
    return box;
  }

  private duel(duelId: number): MockDuel {
    const duel = this.duels[duelId];
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
      owner: b.owner,
      status: b.status,
      aliveCheck: b.aliveCheck,
      partner: b.partner,
      wins: b.wins,
      feeds: b.feeds,
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
