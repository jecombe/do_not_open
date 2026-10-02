import type { ActionOptions, Address, ChainAdapter, CollectionInfo, EconomyInfo } from "@dno/chain-adapter";

/**
 * The bureau de change: five tokens and the direct ways between them. Any pair is reached by
 * the shortest chain of those ways, each one its own transaction, run one after the other.
 *
 *   ETH ─ramp─▶ USDC ◀─shield/unshield─▶ cUSDC        (ETH ─ramp+shield─▶ cUSDC in one go)
 *                 ▲
 *              market
 *                 ▼
 *               CROQ ◀─wrap/unwrap─▶ cCROQ
 *
 * Every token in the middle of a route is a public one (USDC or CROQ), so what a step really
 * handed over can be read from the balance, and the next step spends exactly that.
 */
export type TokenKey = "eth" | "usdc" | "cusdc" | "croq" | "ccroq";
export const TOKENS: TokenKey[] = ["eth", "usdc", "cusdc", "croq", "ccroq"];

export interface TokenInfo {
  key: TokenKey;
  symbol: string;
  decimals: number;
  /** Confidential: only its holder can read the balance. */
  sealed: boolean;
}

export type LegKind = "ramp" | "rampShield" | "shield" | "unshield" | "buyCroq" | "sellCroq" | "wrap" | "unwrap";

export interface Leg {
  kind: LegKind;
  from: TokenKey;
  to: TokenKey;
}

const EDGES: Leg[] = [
  { kind: "rampShield", from: "eth", to: "cusdc" },
  { kind: "ramp", from: "eth", to: "usdc" },
  { kind: "shield", from: "usdc", to: "cusdc" },
  { kind: "unshield", from: "cusdc", to: "usdc" },
  { kind: "buyCroq", from: "usdc", to: "croq" },
  { kind: "sellCroq", from: "croq", to: "usdc" },
  { kind: "wrap", from: "croq", to: "ccroq" },
  { kind: "unwrap", from: "ccroq", to: "croq" },
];

/** Legs that swap on a pool, where a price can move between quote and trade. */
export const SWAPS: ReadonlySet<LegKind> = new Set(["ramp", "rampShield", "buyCroq", "sellCroq"]);
/** Legs that wait for a public decryption of the amount: slower, a minute or so. */
export const DECRYPTS: ReadonlySet<LegKind> = new Set(["unshield", "unwrap"]);

/** What the network offers: the ramp, the market and the croquettes may each be missing. */
export interface Desk {
  tokens: Record<TokenKey, TokenInfo>;
  /** Fee the ramp keeps, in basis points; null without a ramp. */
  rampBps: number | null;
  market: EconomyInfo["market"];
  /** False where the croquette economy is not deployed. */
  croq: boolean;
}

export function deskOf(collection: CollectionInfo, economy: EconomyInfo | null): Desk {
  const p = collection.payment;
  return {
    tokens: {
      eth: { key: "eth", symbol: collection.currency.symbol, decimals: collection.currency.decimals, sealed: false },
      usdc: { key: "usdc", symbol: p.symbol, decimals: p.decimals, sealed: false },
      cusdc: { key: "cusdc", symbol: p.confidentialSymbol, decimals: p.decimals, sealed: true },
      croq: { key: "croq", symbol: economy?.symbol ?? "CROQ", decimals: 0, sealed: false },
      ccroq: { key: "ccroq", symbol: economy?.confidentialSymbol ?? "cCROQ", decimals: 0, sealed: true },
    },
    rampBps: p.ramp?.feeBps ?? null,
    market: economy?.market ?? null,
    croq: !!economy,
  };
}

function open(desk: Desk, leg: Leg): boolean {
  switch (leg.kind) {
    case "ramp":
    case "rampShield":
      return desk.rampBps !== null;
    case "buyCroq":
    case "sellCroq":
      return !!desk.market;
    case "wrap":
    case "unwrap":
      return desk.croq;
    default:
      return true;
  }
}

/** The shortest chain of legs from one token to another, or null when there is none. */
export function findRoute(desk: Desk, from: TokenKey, to: TokenKey): Leg[] | null {
  if (from === to) return null;
  const edges = EDGES.filter((e) => open(desk, e));
  const back = new Map<TokenKey, Leg>();
  const queue: TokenKey[] = [from];
  const seen = new Set<TokenKey>([from]);
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of edges) {
      if (e.from !== at || seen.has(e.to)) continue;
      seen.add(e.to);
      back.set(e.to, e);
      if (e.to === to) {
        const route: Leg[] = [];
        for (let k: TokenKey = to; k !== from; k = back.get(k)!.from) route.unshift(back.get(k)!);
        return route;
      }
      queue.push(e.to);
    }
  }
  return null;
}

/** Tokens reachable from `from` on this desk. */
export function reachable(desk: Desk, from: TokenKey): Set<TokenKey> {
  return new Set(TOKENS.filter((t) => t !== from && findRoute(desk, from, t)));
}

export interface LegQuote extends Leg {
  amountIn: bigint;
  amountOut: bigint;
  /** The least this leg may give once slippage is counted. Equal to `amountOut` off pools. */
  minOut: bigint;
  /** The site's fee, in the input token. Only the ramp takes one. */
  fee: bigint;
  /** How far the pool's price moves against the trade, as a fraction (0.012 for 1.2%). */
  impact: number | null;
}

export interface Quote {
  legs: LegQuote[];
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  /** Plain USDC kept back from the last leg for decryption credits; 0 without a split. */
  kept: bigint;
  /** The least of it once slippage is counted. */
  keptMin: bigint;
}

/**
 * A route that ends by sealing plain USDC (or ETH bought into it) into cUSDC can keep a share
 * of it plain: decryption credits are bought in plain USDC only.
 */
export const canKeep = (route: Leg[]) => {
  const last = route[route.length - 1];
  return last?.kind === "shield" || last?.kind === "rampShield";
};

/** The part of `amount` kept back, `keepBps` of it. */
export const keptPart = (amount: bigint, keepBps: number) => (amount * BigInt(keepBps)) / 10_000n;

/** Transactions a route takes: a ramp-and-shield split in two is two buys on the ramp. */
export const txCount = (route: Leg[], keepBps: number) =>
  route.length + (keepBps > 0 && route[route.length - 1]?.kind === "rampShield" ? 1 : 0);

/** Slippage applied to a pool's quote, as the adapter will. */
export const slipped = (amount: bigint, bps: number) => (amount * BigInt(10_000 - bps)) / 10_000n;

/**
 * Chains each leg's quote into the next. Pool legs ask the chain; the others are 1:1. With
 * `keepBps`, a route that ends in cUSDC keeps that share plain: the shield seals the rest, or
 * the ramp buys the share plain and the rest sealed.
 */
export async function quoteRoute(adapter: ChainAdapter, desk: Desk, route: Leg[], amountIn: bigint, slippageBps: number, keepBps = 0): Promise<Quote> {
  const legs: LegQuote[] = [];
  let amount = amountIn;
  let floor = amountIn;
  let kept = 0n;
  let keptMin = 0n;
  const split = keepBps > 0 && canKeep(route);
  for (const [i, leg] of route.entries()) {
    let out = amount;
    let fee = 0n;
    let impact: number | null = null;
    if (split && i === route.length - 1) {
      const keptIn = keptPart(amount, keepBps);
      const keptFloor = keptPart(floor, keepBps);
      if (leg.kind === "rampShield") {
        const [plain, sealed] = await Promise.all([adapter.quoteUsdc(keptIn), adapter.quoteUsdc(amount - keptIn)]);
        kept = plain.usdcOut;
        keptMin = slipped(keptIn > 0n ? (keptFloor * plain.usdcOut) / keptIn : 0n, slippageBps);
        out = sealed.usdcOut;
        fee = plain.fee + sealed.fee;
        const sealedIn = amount - keptIn;
        const minOut = slipped(sealedIn > 0n ? ((floor - keptFloor) * out) / sealedIn : 0n, slippageBps);
        legs.push({ ...leg, amountIn: amount, amountOut: out, minOut, fee, impact });
        amount = out;
        floor = minOut;
      } else {
        // A shield is 1:1: what is not sealed stays in the wallet as it came.
        kept = keptIn;
        keptMin = keptFloor;
        legs.push({ ...leg, amountIn: amount - keptIn, amountOut: amount - keptIn, minOut: floor - keptFloor, fee, impact });
        amount -= keptIn;
        floor -= keptFloor;
      }
      continue;
    }
    if (leg.kind === "ramp" || leg.kind === "rampShield") {
      const q = await adapter.quoteUsdc(amount);
      out = q.usdcOut;
      fee = q.fee;
    } else if (leg.kind === "buyCroq" || leg.kind === "sellCroq") {
      const side = leg.kind === "buyCroq" ? "buy" : "sell";
      out = await adapter.quote(side, amount);
      impact = priceImpact(desk.market, side, amount, out);
    }
    // The floor follows the worst case: each pool leg may give `slippage` less, and the next
    // leg then spends that smaller amount.
    const ratioOut = amount > 0n ? (floor * out) / amount : 0n;
    const minOut = SWAPS.has(leg.kind) ? slipped(ratioOut, slippageBps) : ratioOut;
    legs.push({ ...leg, amountIn: amount, amountOut: out, minOut, fee, impact });
    amount = out;
    floor = minOut;
  }
  return { legs, amountIn, amountOut: amount, minOut: floor, kept, keptMin };
}

/** 1 − (what the trade gets) / (what the pool's current price promises), pool fee included. */
function priceImpact(market: Desk["market"], side: "buy" | "sell", amountIn: bigint, out: bigint): number | null {
  if (!market || market.croqReserve <= 0n || market.quoteReserve <= 0n || amountIn <= 0n) return null;
  const [rIn, rOut] = side === "buy" ? [market.quoteReserve, market.croqReserve] : [market.croqReserve, market.quoteReserve];
  const spotOut = (Number(amountIn) * Number(rOut)) / Number(rIn);
  if (spotOut <= 0) return null;
  return Math.max(0, 1 - Number(out) / spotOut);
}

/** A public balance, read straight from the chain. Null for sealed ones: they need a signature. */
export async function publicBalance(adapter: ChainAdapter, account: Address, token: TokenKey): Promise<bigint | null> {
  switch (token) {
    case "eth":
      return adapter.balance(account);
    case "usdc":
      return adapter.usdcBalance(account);
    case "croq":
      return adapter.croqBalance(account);
    default:
      return null;
  }
}

export interface RouteResult {
  /** What the last leg delivered, or null when it landed in a sealed balance nobody can read for free. */
  received: bigint | null;
  /** Plain USDC kept back for decryption credits; 0 without a split. */
  kept: bigint;
}

/**
 * Runs a route, leg after leg. The first leg spends `amountIn`; each next one spends what the
 * previous one actually delivered, read from the (public) balance it landed in. With
 * `keepBps`, the last leg keeps that share in plain USDC (see `quoteRoute`).
 * Throws `StoppedAt` when a leg delivered nothing, so the caller can say where the money stopped.
 */
export async function runRoute(
  adapter: ChainAdapter,
  account: Address,
  route: Leg[],
  amountIn: bigint,
  slippageBps: number,
  opts: ActionOptions,
  onLeg: (index: number) => void,
  keepBps = 0,
): Promise<RouteResult> {
  let amount = amountIn;
  let kept = 0n;
  for (let i = 0; i < route.length; i++) {
    const leg = route[i]!;
    onLeg(i);
    if (keepBps > 0 && i === route.length - 1 && canKeep(route)) {
      const keptIn = keptPart(amount, keepBps);
      if (leg.kind === "rampShield") {
        // The plain share first: its USDC can be read, so a buy that gave nothing shows.
        const before = await adapter.usdcBalance(account);
        if (keptIn > 0n) await adapter.buyUsdc(keptIn, false, { ...opts, slippageBps });
        kept = (await adapter.usdcBalance(account)) - before;
      } else {
        kept = keptIn;
      }
      amount -= keptIn;
    }
    const before = await publicBalance(adapter, account, leg.to);
    let got: bigint | null;
    try {
      got = await runLeg(adapter, leg, amount, slippageBps, opts);
    } catch (error) {
      if (error instanceof StoppedAt) error.index = i;
      throw error;
    }
    let delivered = got;
    if (delivered === null && before !== null) {
      delivered = (await publicBalance(adapter, account, leg.to))! - before;
      // A node a block behind reads the old balance: ask once more before calling it nothing.
      if (delivered <= 0n) {
        await new Promise((r) => setTimeout(r, 2500));
        delivered = (await publicBalance(adapter, account, leg.to))! - before;
      }
    }
    if (delivered !== null && delivered <= 0n) throw new StoppedAt(i, leg);
    if (i === route.length - 1) return { received: delivered, kept };
    // Only the last leg may land in a sealed balance, so `delivered` is known here.
    amount = delivered!;
  }
  return { received: amount, kept };
}

/** What one leg delivered when the adapter says so (an unshield's decrypted amount), else null. */
async function runLeg(adapter: ChainAdapter, leg: Leg, amount: bigint, slippageBps: number, opts: ActionOptions): Promise<bigint | null> {
  const swap = { ...opts, slippageBps };
  switch (leg.kind) {
    case "ramp":
      await adapter.buyUsdc(amount, false, swap);
      return null;
    case "rampShield":
      await adapter.buyUsdc(amount, true, swap);
      return null;
    case "shield":
      await adapter.shieldUsdc(amount, opts);
      return null;
    case "unshield": {
      const got = await adapter.unshieldUsdc(amount, opts);
      if (got === 0n) throw new StoppedAt(-1, leg);
      return got;
    }
    case "buyCroq":
      await adapter.trade("buy", amount, swap);
      return null;
    case "sellCroq":
      await adapter.trade("sell", amount, swap);
      return null;
    case "wrap":
      await adapter.wrap(amount, opts);
      return null;
    case "unwrap":
      await adapter.unwrap(amount, opts);
      return null;
  }
}

/** A leg that delivered nothing: a sealed balance smaller than asked, most of the time. */
export class StoppedAt extends Error {
  constructor(
    /** Index of the leg in the route; -1 until `runRoute` sets it. */
    public index: number,
    public leg: Leg,
  ) {
    super(`Nothing came out of ${leg.from} → ${leg.to}.`);
  }
}
