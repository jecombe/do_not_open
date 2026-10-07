import type { ProtocolEvent } from "../domain/events";
import type { Address } from "../domain/types";
import type { AllowListClaim } from "./allowList";
import type { Idea } from "./ideas";
import type { Store } from "./ports/store";
import type { Seats } from "./seats";
import { TASK_FIELD, X_TASKS, type XPass, type XTask } from "./xPass";

/**
 * The team's dashboard (the admin site): how the boarding page and the game are doing, read
 * from the index and the passes. Read-only. A wallet is never listed next to a handle: the list
 * says whether a pass has one, and `walletOf` shows it on demand, one pass at a time.
 */

const DAY = 86_400;
const HOUR = 3_600;

/** The on-chain events each chart counts. */
const CHAIN = {
  purchases: "MintPlaced",
  opened: "Observed",
  shakes: "Shaken",
  meals: "MealServed",
  duels: "DuelPosted",
  duelsSettled: "DuelResolved",
  rats: "RatMinted",
  packs: "PackBought",
  swaps: "Bought",
} as const;
type ChainKey = keyof typeof CHAIN;

export interface Kpi {
  key: string;
  /** Since the start. */
  total: number;
  /** Since 00:00 UTC, and the day before. */
  today: number;
  yesterday: number;
  /** The last 7 days, and the 7 before them. */
  last7: number;
  prev7: number;
  /** One value per day of the period, oldest first. */
  spark: number[];
}

export interface DayRow {
  /** YYYY-MM-DD, UTC. */
  day: string;
  [series: string]: number | string;
}

export interface FeedItem {
  at: number;
  kind: string;
  /** An X handle, a pass code, or a short address on-chain. */
  who: string | null;
  /** The task for `task`, the idea's text for `idea`, the event for `chain`; empty otherwise. */
  text: string;
}

export interface Dashboard {
  generatedAt: number;
  days: number;
  kpis: Kpi[];
  seats: { taken: number; places: number | null; required: readonly XTask[]; perDay: number; daysToFull: number | null };
  /** The boarding page's steps, each counting the passes that reached it. */
  funnel: { step: string; count: number }[];
  /** How many passes declared each task. */
  tasks: Record<XTask, number>;
  /** Median seconds from a pass's creation to its seat. */
  medianToSeat: number | null;
  boarding: DayRow[];
  chain: DayRow[];
  /** Actions per UTC weekday (0 = Monday) and hour, over the period. */
  heatmap: number[][];
  ideasByLocale: Record<string, number>;
  recent: FeedItem[];
}

export interface PlayerRow {
  code: string;
  handle: string | null;
  createdAt: number;
  verifiedAt: number | null;
  tasks: Record<XTask, number | null>;
  seated: boolean;
  seatedAt: number | null;
  wallet: boolean;
  claimed: boolean;
  discord: boolean;
  tweetUrl: string | null;
  updatedAt: number;
}

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** When a pass sat down: its account and its last required task, whichever came later. */
export function seatedAt(p: XPass, required: readonly XTask[]): number | null {
  if (!p.handle) return null;
  const times = required.map((t) => p[TASK_FIELD[t]]);
  if (times.some((t) => t === null)) return null;
  return Math.max(p.verifiedAt ?? p.createdAt, ...(times as number[]));
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

export class Insights {
  constructor(
    private readonly store: Store,
    private readonly seats: Seats,
    private readonly clock: { now(): number },
  ) {}

  async dashboard(days: number): Promise<Dashboard> {
    const now = this.clock.now();
    const today = Math.floor(now / DAY) * DAY;
    const from = today - (days - 1) * DAY;
    const [allPasses, allClaims, ideas, buckets, hours, active, taken, recentChain] = await Promise.all([
      this.store.xPasses(),
      this.store.allowListClaims(),
      this.store.ideas(),
      this.store.eventBuckets(0, DAY),
      this.store.eventBuckets(from, HOUR),
      this.store.activeAccounts(Math.min(from, today - 14 * DAY), DAY),
      this.seats.taken(),
      this.store.activity({ limit: 40 }),
    ]);
    const required = this.seats.required;
    // The team's own wallets and passes are tests, not players.
    const passes = allPasses.filter((p) => !this.seats.isTeamPass(p));
    const claims = allClaims.filter((c) => !this.seats.isTeam(c.address));

    // Every dated fact, by series: a pass's steps, claims, ideas, and the chain's events.
    const facts = new Map<string, number[]>();
    const add = (series: string, t: number | null) => {
      if (t === null) return;
      const list = facts.get(series) ?? [];
      list.push(t);
      facts.set(series, list);
    };
    for (const p of passes) {
      add("passes", p.createdAt);
      if (p.handle) add("x", p.verifiedAt ?? p.updatedAt);
      for (const t of X_TASKS) add(`task:${t}`, p[TASK_FIELD[t]]);
      add("seated", seatedAt(p, required));
      add("discord", p.discordJoinedAt);
    }
    for (const c of claims) add("claims", c.claimedAt);
    for (const i of ideas) add("ideas", i.createdAt);

    // The chain's events come counted by day already.
    const chainDays = new Map<string, Map<string, number>>();
    for (const b of buckets) {
      const byName = chainDays.get(b.name) ?? new Map<string, number>();
      byName.set(dayOf(b.start), (byName.get(dayOf(b.start)) ?? 0) + b.count);
      chainDays.set(b.name, byName);
    }
    const activeByDay = new Map(active.map((a) => [dayOf(a.start), a.accounts]));

    const dayList = Array.from({ length: days }, (_, i) => dayOf(from + i * DAY));
    const perDay = (series: string): Map<string, number> => {
      const out = new Map<string, number>();
      if (series.startsWith("chain:")) return chainDays.get(series.slice(6)) ?? out;
      if (series === "active") return activeByDay;
      for (const t of facts.get(series) ?? []) out.set(dayOf(t), (out.get(dayOf(t)) ?? 0) + 1);
      return out;
    };
    const sumSince = (m: Map<string, number>, start: number, end = Infinity) => {
      let n = 0;
      for (const [d, c] of m) {
        const t = Date.parse(`${d}T00:00:00Z`) / 1000;
        if (t >= start && t < end) n += c;
      }
      return n;
    };
    const kpi = (key: string, series: string, total?: number): Kpi => {
      const m = perDay(series);
      return {
        key,
        total: total ?? [...m.values()].reduce((a, b) => a + b, 0),
        today: m.get(dayOf(today)) ?? 0,
        yesterday: m.get(dayOf(today - DAY)) ?? 0,
        last7: sumSince(m, today - 6 * DAY),
        prev7: sumSince(m, today - 13 * DAY, today - 6 * DAY),
        spark: dayList.map((d) => m.get(d) ?? 0),
      };
    };
    const claimed = new Set<Address>(claims.map((c) => c.address));
    const kpis: Kpi[] = [
      kpi("passes", "passes"),
      kpi("x", "x"),
      kpi("seated", "seated"),
      kpi("discord", "discord"),
      kpi("claims", "claims"),
      kpi("ideas", "ideas"),
      kpi("purchases", `chain:${CHAIN.purchases}`),
      kpi("opened", `chain:${CHAIN.opened}`),
      kpi("duels", `chain:${CHAIN.duels}`),
      kpi("rats", `chain:${CHAIN.rats}`),
      kpi("packs", `chain:${CHAIN.packs}`),
      // A distinct count does not add up across days: the total is the period's busiest day.
      { ...kpi("active", "active"), total: Math.max(0, ...activeByDay.values()) },
    ];

    // The seats' pace over the last 7 days, and when the list fills at that pace.
    const seatedLast7 = sumSince(perDay("seated"), today - 6 * DAY) + sumSince(perDay("claims"), today - 6 * DAY);
    const pace = seatedLast7 / 7;
    const places = this.seats.places;
    const daysToFull = places === null || pace <= 0 ? null : Math.max(0, Math.ceil((places - taken) / pace));

    const withX = passes.filter((p) => p.handle);
    const funnel = [
      { step: "pass", count: passes.length },
      { step: "x", count: withX.length },
      ...required.map((t) => ({ step: `task:${t}`, count: withX.filter((p) => p[TASK_FIELD[t]] !== null).length })),
      { step: "seated", count: passes.filter((p) => seatedAt(p, required) !== null).length },
      { step: "wallet", count: passes.filter((p) => p.address).length },
      { step: "claimed", count: passes.filter((p) => p.address && claimed.has(p.address)).length },
      { step: "discord", count: passes.filter((p) => p.discordUserId).length },
    ];
    const tasks = Object.fromEntries(X_TASKS.map((t) => [t, passes.filter((p) => p[TASK_FIELD[t]] !== null).length])) as Record<XTask, number>;
    const medianToSeat = median(passes.flatMap((p) => {
      const s = seatedAt(p, required);
      return s === null ? [] : [s - p.createdAt];
    }));

    const row = (d: string, series: Record<string, string>): DayRow => {
      const r: DayRow = { day: d };
      for (const [key, s] of Object.entries(series)) r[key] = perDay(s).get(d) ?? 0;
      return r;
    };
    const boardingSeries = { passes: "passes", x: "x", seated: "seated", claims: "claims", discord: "discord", ideas: "ideas" };
    const chainSeries = Object.fromEntries([...Object.entries(CHAIN).map(([k, n]) => [k, `chain:${n}`]), ["active", "active"]]) as Record<ChainKey | "active", string>;

    // Each action counts once, the boarding page's and the chain's, by UTC weekday and hour.
    const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const mark = (t: number, n = 1) => {
      const d = new Date(t * 1000);
      heatmap[(d.getUTCDay() + 6) % 7]![d.getUTCHours()]! += n;
    };
    for (const [series, times] of facts) if (series !== "seated") for (const t of times) if (t >= from) mark(t);
    for (const h of hours) mark(h.start, h.count);

    const ideasByLocale: Record<string, number> = {};
    for (const i of ideas) ideasByLocale[i.locale] = (ideasByLocale[i.locale] ?? 0) + 1;

    return {
      generatedAt: now,
      days,
      kpis,
      seats: { taken, places, required, perDay: Math.round(pace * 10) / 10, daysToFull },
      funnel,
      tasks,
      medianToSeat,
      boarding: dayList.map((d) => row(d, boardingSeries)),
      chain: dayList.map((d) => row(d, chainSeries)),
      heatmap,
      ideasByLocale,
      recent: recentItems(passes, claims, ideas, recentChain, required).slice(0, 60),
    };
  }

  /** Every pass, newest first, without its wallet. */
  async players(): Promise<PlayerRow[]> {
    const [passes, claims] = await Promise.all([this.store.xPasses(), this.store.allowListClaims()]);
    const claimed = new Set(claims.map((c) => c.address));
    return passes
      .filter((p) => !this.seats.isTeamPass(p))
      .map((p): PlayerRow => {
        const seat = seatedAt(p, this.seats.required);
        return {
          code: p.code,
          handle: p.handle,
          createdAt: p.createdAt,
          verifiedAt: p.verifiedAt,
          tasks: Object.fromEntries(X_TASKS.map((t) => [t, p[TASK_FIELD[t]]])) as Record<XTask, number | null>,
          seated: seat !== null,
          seatedAt: seat,
          wallet: !!p.address,
          claimed: !!p.address && claimed.has(p.address),
          discord: !!p.discordUserId,
          tweetUrl: p.tweetUrl,
          updatedAt: p.updatedAt,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The wallet linked to one pass, or null. */
  async walletOf(code: string): Promise<Address | null> {
    return (await this.store.xPassByCode(code))?.address ?? null;
  }

  async ideas(): Promise<Idea[]> {
    return this.store.ideas();
  }
}

/** The latest steps on the boarding page and the chain, newest first. Wallets show only for a claim with no pass, shortened. */
function recentItems(passes: XPass[], claims: AllowListClaim[], ideas: Idea[], chain: ProtocolEvent[], required: readonly XTask[]): FeedItem[] {
  const items: FeedItem[] = [];
  const handleOf = new Map<Address, string>();
  for (const p of passes) {
    const who = p.handle ? `@${p.handle}` : p.code;
    items.push({ at: p.createdAt, kind: "pass", who, text: "" });
    if (p.handle) items.push({ at: p.verifiedAt ?? p.updatedAt, kind: "x", who, text: "" });
    for (const t of X_TASKS) {
      const at = p[TASK_FIELD[t]];
      if (at !== null) items.push({ at, kind: "task", who, text: t });
    }
    const seat = seatedAt(p, required);
    if (seat !== null) items.push({ at: seat, kind: "seated", who, text: "" });
    if (p.discordJoinedAt !== null) items.push({ at: p.discordJoinedAt, kind: "discord", who, text: "" });
    if (p.address && p.handle) handleOf.set(p.address, p.handle);
  }
  for (const c of claims) {
    const handle = handleOf.get(c.address);
    items.push({ at: c.claimedAt, kind: "claim", who: handle ? `@${handle}` : short(c.address), text: "" });
  }
  for (const i of ideas) items.push({ at: i.createdAt, kind: "idea", who: i.handle ? `@${i.handle}` : null, text: i.text.length > 140 ? `${i.text.slice(0, 140)}…` : i.text });
  for (const e of chain) {
    if (e.timestamp === null) continue;
    const id = "tokenId" in e ? ` box #${e.tokenId}` : "ratId" in e ? ` rat #${e.ratId}` : "duelId" in e ? ` duel #${e.duelId}` : "";
    items.push({ at: e.timestamp, kind: "chain", who: null, text: `${e.name}${id}` });
  }
  return items.sort((a, b) => b.at - a.at);
}
