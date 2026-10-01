import { Interface, type LogDescription, type Result } from "ethers";
import type { ChainBatch, ChainSource, EntityQuery, ReadOptions } from "../../application/ports/chain";
import type { Logger } from "../../application/ports/logger";
import { emptySnapshots, type ProtocolEvent, type Snapshots, type Source } from "../../domain/events";
import { normalizeAddress, ZERO_ADDRESS, type Build, type DuelStatus, type RequestKind, type RequestStatus, type RevealedContents } from "../../domain/types";
import type { ProtocolDeployment } from "./deployment";
import { multicall, type ViewCall } from "./multicall";
import type { LogFilter, RawLog, RpcPool } from "./RpcPool";

const REQUEST_KINDS: RequestKind[] = ["open", "aliveCheck", "entangle"];
const REQUEST_STATUS: (RequestStatus | null)[] = [null, "pending", "done", "refused"];
const DUEL_STATUS: (DuelStatus | null)[] = [null, "challenged", "pending", "resolved", "cancelled", "void"];
const BUILDS: Build[] = ["thin", "normal", "chubby", "fat", "huge"];
const DISEASES = ["diabetic", "arthritic", "fattyLiver"] as const;

/** Events worth a row. Ownership changes of the contracts and decryption proofs are left out. */
const INDEXED: Record<Source, string[]> = {
  collection: [
    "MintPlaced", "MilestoneReached", "Shaken", "Fed", "RequestPlaced", "RequestSettled", "Observed", "AliveProven",
    "EntangleProposed", "Entangled", "DuelChallenged", "DuelCancelled", "DuelAccepted", "DuelResolved", "DuelVoided",
    "ConfidentialTransfer",
  ],
  pantry: ["MealServed", "WelcomeBag", "Purred", "Claimed", "WeighInRequested", "Weighed"],
  ramp: ["Bought"],
};

const addr = (v: unknown) => normalizeAddress(String(v));
const num = (v: unknown) => Number(v);

/** Reads the protocol's logs with one `eth_getLogs` per range, for all its contracts at once. */
export class EvmChainSource implements ChainSource {
  private readonly contracts: { source: Source; address: string; iface: Interface }[];
  private readonly topics: string[];
  private readonly collection: Interface;
  private readonly pantry: Interface | null;

  constructor(
    private readonly rpc: RpcPool,
    private readonly d: ProtocolDeployment,
    private readonly log: Logger,
  ) {
    this.collection = new Interface(d.collection.abi);
    this.pantry = d.pantry ? new Interface(d.pantry.abi) : null;
    this.contracts = [
      { source: "collection" as const, address: d.collection.address, iface: this.collection },
      ...(d.pantry ? [{ source: "pantry" as const, address: d.pantry.address, iface: this.pantry! }] : []),
      ...(d.ramp ? [{ source: "ramp" as const, address: d.ramp.address, iface: new Interface(d.ramp.abi) }] : []),
    ].map((c) => ({ ...c, address: c.address.toLowerCase() }));
    this.topics = this.contracts.flatMap((c) => INDEXED[c.source].map((name) => c.iface.getEvent(name)!.topicHash));
  }

  async head(): Promise<number> {
    return Number(await this.rpc.call<string>("eth_blockNumber", []));
  }

  async finalized(): Promise<number> {
    const header = await this.rpc.call<{ number: string } | null>("eth_getBlockByNumber", ["finalized", false]);
    if (!header) throw new Error("the endpoint knows no finalized block");
    return Number(header.number);
  }

  async read(from: number, to: number, opts: ReadOptions = {}): Promise<ChainBatch> {
    const got = await this.rpc.getLogs({ address: this.addresses(), topics: [this.topics] }, from, to, opts);
    return { to: got.to, servedBy: [got.endpoint], ...(await this.complete(got.logs)) };
  }

  /**
   * Every event naming these boxes, duels or requests in an indexed topic, over the whole range.
   * A box id can sit in topic 1, 2 or 3 (a duel's loser is the third), so three filters; an id
   * that happens to match another event's topic brings a real event too, which does no harm.
   */
  async eventsOf(q: EntityQuery, from: number, to: number): Promise<Pick<ChainBatch, "events" | "snapshots">> {
    const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    const topic = (name: string) => this.collection.getEvent(name)!.topicHash;
    const filters: LogFilter[] = [];
    if (q.tokenIds?.length) {
      const ids = q.tokenIds.map(word);
      filters.push({ address: this.addresses(), topics: [this.topics, ids] });
      filters.push({ address: this.addresses(), topics: [this.topics, null, ids] });
      filters.push({ address: this.addresses(), topics: [this.topics, null, null, ids] });
    }
    if (q.duelIds?.length) {
      filters.push({ address: [this.d.collection.address], topics: [["DuelChallenged", "DuelAccepted", "DuelCancelled", "DuelResolved", "DuelVoided"].map(topic), q.duelIds.map(word)] });
    }
    if (q.requestIds?.length) {
      filters.push({ address: [this.d.collection.address], topics: [["RequestPlaced", "RequestSettled"].map(topic), q.requestIds.map(word)] });
    }
    if (q.milestones) filters.push({ address: [this.d.collection.address], topics: [[topic("MilestoneReached")]] });

    const logs = new Map<string, RawLog>();
    for (const filter of filters) {
      for (let at = from; at <= to; ) {
        const got = await this.rpc.getLogs(filter, at, to);
        for (const l of got.logs) logs.set(`${l.transactionHash}:${l.logIndex}`, l);
        at = got.to + 1;
      }
    }
    return this.complete([...logs.values()]);
  }

  private addresses() {
    return this.contracts.map((c) => c.address);
  }

  /** Decodes raw logs and adds their timestamps and snapshots. */
  private async complete(logs: RawLog[]): Promise<Pick<ChainBatch, "events" | "snapshots">> {
    const decoded = logs.flatMap((l) => this.decodeLog(l));
    const [timestamps, snapshots] = await Promise.all([this.timestamps(decoded.map((e) => e.block)), this.snapshots(decoded)]);
    const events = decoded.map((e) => ({ ...e, timestamp: timestamps.get(e.block) ?? null }));
    return { events, snapshots };
  }

  private decodeLog(l: RawLog): ProtocolEvent[] {
    const contract = this.contracts.find((c) => c.address === l.address.toLowerCase());
    if (!contract) return [];
    let parsed: LogDescription | null;
    try {
      parsed = contract.iface.parseLog({ topics: l.topics, data: l.data });
    } catch (error) {
      this.log.warn({ tx: l.transactionHash, error: (error as Error).message }, "undecodable log");
      return [];
    }
    if (!parsed) return [];
    const body = toBody(parsed.name, parsed.args);
    if (!body) return [];
    const block = Number(l.blockNumber);
    return [
      {
        ...body,
        source: contract.source,
        block,
        blockHash: l.blockHash?.toLowerCase() ?? null,
        timestamp: null,
        txHash: l.transactionHash.toLowerCase(),
        logIndex: Number(l.logIndex),
      } as ProtocolEvent,
    ];
  }

  /** One batched request for the blocks the events sit in. A missing timestamp is not worth failing a batch. */
  private async timestamps(blocks: number[]): Promise<Map<number, number>> {
    const unique = [...new Set(blocks)];
    const out = new Map<number, number>();
    if (!unique.length) return out;
    try {
      const headers = await this.rpc.batch<{ timestamp: string } | null>(unique.map((b) => ({ method: "eth_getBlockByNumber", params: [`0x${b.toString(16)}`, false] })));
      headers.forEach((h, i) => h && out.set(unique[i]!, Number(h.timestamp)));
    } catch (error) {
      this.log.warn({ error: (error as Error).message }, "block timestamps unavailable");
    }
    return out;
  }

  /** What the logs leave out, for every duel, request, opening and weigh-in of the batch, in one multicall. */
  private async snapshots(events: ProtocolEvent[]): Promise<Snapshots> {
    const s = emptySnapshots();
    const duels = new Set<number>();
    const requests = new Set<number>();
    const opened = new Set<number>();
    const weighed = new Set<number>();
    for (const e of events) {
      if (e.name === "DuelChallenged" || e.name === "DuelAccepted" || e.name === "DuelCancelled" || e.name === "DuelVoided" || e.name === "DuelResolved") duels.add(e.duelId);
      if (e.name === "RequestPlaced" || e.name === "RequestSettled") requests.add(e.requestId);
      if (e.name === "Observed") opened.add(e.tokenId);
      if (e.name === "Weighed") weighed.add(e.tokenId);
    }
    const c = this.d.collection.address;
    const calls: (ViewCall & { apply: (r: Result) => void })[] = [
      ...[...duels].map((id) => ({
        target: c, iface: this.collection, fn: "duelInfo", args: [id],
        apply: (r: Result) => s.duels.set(id, {
          tokenA: num(r.tokenIdA),
          tokenB: num(r.tokenIdB),
          challenger: r.challenger === ZERO_ADDRESS ? null : addr(r.challenger),
          accepter: r.accepter === ZERO_ADDRESS ? null : addr(r.accepter),
          status: DUEL_STATUS[num(r.duelStatus)] ?? null,
        }),
      })),
      ...[...requests].map((id) => ({
        target: c, iface: this.collection, fn: "requestInfo", args: [id],
        apply: (r: Result) => s.requests.set(id, {
          kind: REQUEST_KINDS[num(r.kind)] ?? "open",
          status: REQUEST_STATUS[num(r.requestStatus)] ?? null,
          requester: addr(r.requester),
          tokenId: num(r.tokenId),
          other: num(r.other) ? num(r.other) - 1 : null,
        }),
      })),
      ...[...opened].map((id) => ({
        target: c, iface: this.collection, fn: "contentsOf", args: [id],
        apply: (r: Result) => s.contents.set(id, contentsFrom(r[0])),
      })),
      ...(this.pantry && this.d.pantry
        ? [...weighed].map((id) => ({
            target: this.d.pantry!.address, iface: this.pantry!, fn: "weighIn", args: [id],
            apply: (r: Result) => {
              const w = r[0];
              s.weighIns.set(id, {
                weight: String(w.weight),
                build: BUILDS[num(w.build)] ?? "normal",
                sick: Boolean(w.sick),
                disease: w.sick ? (DISEASES[num(w.disease)] ?? null) : null,
                tolerance: String(w.tolerance),
              });
            },
          }))
        : []),
    ];
    if (!calls.length) return s;
    try {
      const results = await multicall(this.rpc, calls);
      results.forEach((r, i) => r && calls[i]!.apply(r));
    } catch (error) {
      // Fail the pass rather than index without them: nothing is written, the next pass retries.
      this.log.warn({ error: (error as Error).message, calls: calls.length }, "snapshot read failed");
      throw error;
    }
    return s;
  }
}

function contentsFrom(c: Result): RevealedContents {
  return {
    seed: String(c.seed),
    state: num(c.state),
    traits: [...c.traits].map(num),
    score: num(c.score),
    affection: num(c.affection),
    golden: Boolean(c.golden),
  };
}

/** The event's own fields, in the domain's words. Null for an event the index ignores. */
function toBody(name: string, a: Result): Record<string, unknown> | null {
  switch (name) {
    case "MintPlaced":
      return { name, firstTokenId: num(a.firstTokenId), buyer: addr(a.buyer), count: num(a.count) };
    case "MilestoneReached":
      return { name, index: num(a.index), sold: num(a.sold) };
    case "Shaken":
      return { name, tokenId: num(a.tokenId), viewer: addr(a.viewer), paid: Boolean(a.paid) };
    case "Fed":
      return { name, tokenId: num(a.tokenId), feeder: addr(a.feeder) };
    case "RequestPlaced":
      return { name, requestId: num(a.requestId), tokenId: num(a.tokenId), requester: addr(a.requester), kind: REQUEST_KINDS[num(a.kind)] ?? "open" };
    case "RequestSettled":
      return { name, requestId: num(a.requestId), status: num(a.status) === 2 ? "done" : "refused" };
    case "Observed":
      return { name, tokenId: num(a.tokenId), openedBy: addr(a.openedBy), seed: String(a.seed), state: num(a.state), score: num(a.rarityScore), golden: Boolean(a.golden) };
    case "AliveProven":
      return { name, tokenId: num(a.tokenId), alive: Boolean(a.alive) };
    case "EntangleProposed":
      return { name, tokenA: num(a.tokenIdA), tokenB: num(a.tokenIdB), proposer: addr(a.proposer) };
    case "Entangled":
      return { name, tokenA: num(a.tokenIdA), tokenB: num(a.tokenIdB) };
    case "DuelChallenged":
      return { name, duelId: num(a.duelId), tokenA: num(a.tokenIdA), tokenB: num(a.tokenIdB) };
    case "DuelCancelled":
    case "DuelAccepted":
    case "DuelVoided":
      return { name, duelId: num(a.duelId) };
    case "DuelResolved":
      return { name, duelId: num(a.duelId), winner: num(a.winnerTokenId), loser: num(a.loserTokenId), traitIndex: num(a.revealedTraitIndex), roll: num(a.revealedTraitRoll) };
    case "ConfidentialTransfer":
      return { name, tokenId: num(a.tokenId), from: addr(a.from), to: addr(a.to), moved: String(a.moved) };
    case "MealServed":
      return { name, tokenId: num(a.tokenId), feeder: addr(a.feeder) };
    case "WelcomeBag":
      return { name, tokenId: num(a.tokenId) };
    case "Purred":
      return { name, tokenId: num(a.tokenId), days: num(a.days_) };
    case "Claimed":
      return { name, caller: addr(a.caller), boxes: num(a.boxes) };
    case "WeighInRequested":
      return { name, tokenId: num(a.tokenId) };
    case "Weighed":
      return { name, tokenId: num(a.tokenId), weight: String(a.weight), build: num(a.build), sick: Boolean(a.sick), disease: num(a.disease) };
    case "Bought":
      return { name, buyer: addr(a.buyer), ethIn: String(a.ethIn), fee: String(a.fee), usdcOut: String(a.usdcOut), shielded: Boolean(a.shielded) };
    default:
      return null;
  }
}
