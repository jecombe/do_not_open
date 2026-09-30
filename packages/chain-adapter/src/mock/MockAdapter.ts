import { spec, TRAIT_KEYS } from "@dno/game-spec";
import { buildCatSpec, mulberry32, stateDef } from "@dno/generator";
import {
  ChainError,
  type ActionOptions,
  type Address,
  type AliveCheck,
  type BoxInfo,
  type BoxStatus,
  type ChainAdapter,
  type CollectionInfo,
  type DuelInfo,
  type DuelResult,
  type DuelStatus,
  type PairInfo,
  type RevealedContents,
  type TraitRoll,
  type WalletOption,
} from "../types";

/** The account the mock signs you in as, and the one that holds the other boxes. */
export const MOCK_YOU: Address = "0x00000000000000000000000000000000000d0c4a";
export const MOCK_NIGHT_SHIFT: Address = "0x000000000000000000000000000000000000beef";

const ETH = 10n ** 18n;
const FEES = { mint: ETH / 500n, observe: ETH / 2000n, feed: ETH / 5000n, paidShake: ETH / 1000n };

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
}

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
}

/** Stand-in seed. On a real chain this value is encrypted and nobody can compute it. */
export function mockSeedForToken(tokenId: number): bigint {
  const rand = mulberry32(Math.imul(tokenId + 1, 0x2545f491));
  return (BigInt(Math.floor(rand() * 2 ** 32)) << 32n) | BigInt(Math.floor(rand() * 2 ** 32));
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
  private readonly listeners = new Set<(account: Address | null) => void>();
  private readonly latency: number;

  constructor(opts: MockOptions = {}) {
    this.latency = opts.latency ?? 450;
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

  // --- actions ---

  async mint(quantity: number, opts?: ActionOptions): Promise<number[]> {
    const me = this.signer();
    const max = Number(spec.mechanics.mint?.maxPerTx ?? 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) throw revert("InvalidQuantity");
    if (this.boxes.length + quantity > spec.collection.maxSupply) throw revert("SoldOut");
    await this.send(opts);
    const first = this.boxes.length;
    for (let i = 0; i < quantity; i++) this.boxes.push(this.newBox(me));
    return Array.from({ length: quantity }, (_, i) => first + i);
  }

  async shake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.owner !== me) throw revert("NotHolder");
    await this.send(opts);
    return this.decryptShake(tokenId, opts);
  }

  async paidShake(tokenId: number, opts?: ActionOptions): Promise<TraitRoll> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.owner === me) throw revert("HolderShakesForFree");
    await this.send(opts);
    const share = (FEES.paidShake * BigInt(Number(spec.mechanics.paidShake?.holderShareBps ?? 7000))) / 10_000n;
    this.owed.set(box.owner, (this.owed.get(box.owner) ?? 0n) + share);
    return this.decryptShake(tokenId, opts);
  }

  async feed(tokenId: number, opts?: ActionOptions): Promise<void> {
    this.signer();
    const box = this.sealed(tokenId);
    await this.send(opts);
    box.feeds += 1;
    const rand = mulberry32(Math.imul(tokenId + 7, 0x9e3779b1) + box.feeds * 31337);
    box.affection += Math.floor(rand() * (spec.affection.perFeedMax + 1));
  }

  async proveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.owner !== me) throw revert("NotHolder");
    if (box.aliveCheck !== "none") throw revert("AliveCheckAlreadyRequested");
    await this.send(opts);
    box.aliveCheck = "pending";
    return this.finishProveAlive(tokenId, opts);
  }

  async finishProveAlive(tokenId: number, opts?: ActionOptions): Promise<boolean> {
    const box = this.get(tokenId);
    if (box.aliveCheck !== "pending") throw revert("AliveCheckNotPending");
    await this.publish(opts);
    const alive = buildCatSpec({ seed: mockSeedForToken(tokenId) }).state === "alive";
    box.aliveCheck = alive ? "alive" : "notAlive";
    return alive;
  }

  async observe(tokenId: number, opts?: ActionOptions): Promise<BoxInfo[]> {
    const me = this.signer();
    const box = this.sealed(tokenId);
    if (box.owner !== me) throw revert("NotHolder");
    await this.send(opts);
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
      await this.publish(opts);
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
    await this.send(opts);
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
    await this.send(opts);
    this.entangle(tokenA, tokenB);
  }

  async challengeDuel(tokenA: number, tokenB: number, opts?: ActionOptions): Promise<number> {
    const me = this.signer();
    if (this.get(tokenA).owner !== me) throw revert("NotHolder");
    if (tokenA === tokenB) throw revert("SameBox");
    if (this.get(tokenA).status !== "sealed" || this.get(tokenB).status !== "sealed") throw revert("NotSealed");
    await this.send(opts);
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
    await this.send(opts);
    duel.status = "cancelled";
  }

  async acceptDuel(duelId: number, opts?: ActionOptions): Promise<void> {
    const me = this.signer();
    const duel = this.duel(duelId);
    if (duel.status !== "challenged") throw revert("WrongDuelStatus");
    if (this.get(duel.tokenB).owner !== me) throw revert("NotHolder");
    if (this.get(duel.tokenA).owner !== duel.challenger) throw revert("ChallengerNoLongerHolds");
    await this.send(opts);
    duel.status = "pending";
  }

  async finishDuel(duelId: number, opts?: ActionOptions): Promise<DuelResult> {
    const duel = this.duel(duelId);
    if (duel.status !== "pending") throw revert("WrongDuelStatus");
    await this.publish(opts);
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
    await this.send(opts);
    this.owed.set(me, 0n);
  }

  // --- internals ---

  private newBox(owner: Address): MockBox {
    return { owner, status: "sealed", aliveCheck: "none", partner: null, wins: 0, feeds: 0, affection: 0, shakes: 0, publicTraits: new Map(), revealed: null };
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
  private async send(opts?: ActionOptions): Promise<void> {
    opts?.onStep?.("wallet");
    await this.wait(0.6);
    opts?.onStep?.("confirming");
    await this.wait(1);
  }

  /** A public decryption followed by the transaction that carries its proof. */
  private async publish(opts?: ActionOptions): Promise<void> {
    opts?.onStep?.("decrypting");
    await this.wait(1.4);
    opts?.onStep?.("proving");
    await this.wait(1);
  }

  private wait(factor: number): Promise<void> {
    return this.latency ? new Promise((r) => setTimeout(r, this.latency * factor)) : Promise.resolve();
  }
}

const revert = (reason: string) => new ChainError("reverted", `The depot refused: ${reason}.`, reason);
