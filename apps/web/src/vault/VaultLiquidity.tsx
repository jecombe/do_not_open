import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  DEFAULT_POCKET_DECOYS,
  pairedAmount,
  priceAtTick,
  priceOf,
  rangeAround,
  shortAddress,
  type ActionOptions,
  type Address,
  type PositionPool,
  type PositionsInfo,
  type SealedPosition,
  type VaultAdapter,
  type WalletPosition,
} from "@dno/chain-adapter";
import { useAction } from "../chain/ChainProvider";
import { TokenIcon } from "../brand/logos";
import { useT } from "./i18n";

/** What the vault page runs an action with: the stage, the steps, the transactions. */
type Act = <T>(name: string, run: (opts: ActionOptions) => Promise<T>, message?: (r: T) => string, extra?: { token?: string }) => Promise<T | undefined>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** How often pools and positions are read again. */
const POLL_MS = 15_000;
/** The ranges a newcomer picks from: how far the price may go either way before the position stops earning. */
const RANGES = [5, 15, 50, 0] as const;
type RangePct = (typeof RANGES)[number];
/** Dollars: the side a pool's price is quoted in when it has one. */
const STABLES = new Set(["USDC", "USDT"]);

/** Plain units to a short decimal: at most `digits` decimals, trailing zeros dropped. */
export function fmt(amount: bigint, decimals: number, digits = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

const fmtPrice = (p: number) =>
  !Number.isFinite(p) ? "∞" : p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 0 }) : p >= 1 ? p.toLocaleString("en-US", { maximumFractionDigits: 2 }) : p.toPrecision(3);

function parseUnits(value: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m || (m[2]?.length ?? 0) > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

/** How the page reads a pool: the coin priced (base) in the other one (quote), dollars last. */
function quoteOf(p: PositionPool) {
  const [s0, s1] = [p.token0.underlying.symbol, p.token1.underlying.symbol];
  const baseIs0 = STABLES.has(s1) || (!STABLES.has(s0) && !STABLES.has(s1)) || (STABLES.has(s0) && STABLES.has(s1));
  const [base, quote] = baseIs0 ? [p.token0, p.token1] : [p.token1, p.token0];
  /** Whole quote per whole base, from token1 per token0. */
  const orient = (price1per0: number) => (baseIs0 ? price1per0 : 1 / price1per0);
  const d0 = p.token0.underlying.decimals;
  const d1 = p.token1.underlying.decimals;
  return {
    base,
    quote,
    baseIs0,
    price: orient(priceOf(p.sqrtPriceX96, d0, d1)),
    /** A range's two ends, low first, in quote per base. */
    ends: (tickLower: number, tickUpper: number): [number, number] => {
      const [a, b] = [orient(priceAtTick(tickLower, d0, d1)), orient(priceAtTick(tickUpper, d0, d1))];
      return a < b ? [a, b] : [b, a];
    },
    name: `${base.underlying.symbol} / ${quote.underlying.symbol}`,
  };
}

/** What a position's scenes wear: both coins of its pair. */
const pairOf = (p: PositionPool) => {
  const q = quoteOf(p);
  return `${q.base.symbol}/${q.quote.symbol}`;
};

/**
 * The vault's third side: Uniswap V3 liquidity nobody can tie to a wallet. "Pools" shows the pools
 * the pockets' tokens trade in, every position the vault holds (public, as on Uniswap, but for
 * who holds them), and the form that opens one out of the wallet's pockets. "My positions" finds
 * the wallet's positions from the same signature as its pockets and acts on them: collect the
 * fees into the pockets, add, take liquidity out, give a position away, take it out to a wallet,
 * or bring a Uniswap position in.
 */
export function LiquidityTab({
  vault,
  account,
  act,
  busy,
  demo,
  view,
  connect,
  onPockets,
}: {
  vault: VaultAdapter;
  account: Address | null;
  act: Act;
  busy: boolean;
  demo: boolean;
  view: "pools" | "positions";
  connect: ReactNode;
  /** Opens the pockets, where the tokens come from. */
  onPockets: () => void;
}) {
  const t = useT();
  const own = useAction();
  const positions = useMemo(() => vault.positions(), [vault]);
  const [info, setInfo] = useState<PositionsInfo | null>(null);
  const [all, setAll] = useState<SealedPosition[]>([]);
  /** undefined: not looked for yet (a signature away). */
  const [mine, setMine] = useState<SealedPosition[] | undefined>(undefined);
  const [outside, setOutside] = useState<WalletPosition[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [receive, setReceive] = useState<Address | null>(null);

  const readPublic = useCallback(async () => {
    if (!positions) return;
    const [i, a] = await Promise.all([positions.info(), positions.all()]);
    setInfo(i);
    setAll(a);
  }, [positions]);

  const readMine = useCallback(
    async (opts?: ActionOptions) => {
      if (!positions || !account) return;
      setMine(await positions.mine(opts));
      setOutside(await positions.walletPositions().catch(() => []));
    },
    [positions, account],
  );

  useEffect(() => {
    setMine(undefined);
    setOutside([]);
    setReceive(null);
    if (demo && account) void readMine().catch(() => undefined);
  }, [account, demo, readMine]);

  useEffect(() => {
    let live = true;
    const tick = () => void readPublic().catch(() => undefined);
    tick();
    const id = setInterval(() => live && tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [readPublic]);

  // Once unlocked, the wallet's positions follow the pools.
  useEffect(() => {
    if (mine === undefined) return;
    const id = setInterval(() => void readMine().catch(() => undefined), POLL_MS);
    return () => clearInterval(id);
  }, [mine === undefined, readMine]);

  if (!positions) return <p className="vault-meta">{t("vault.lp.missing")}</p>;

  const run = async <T,>(name: string, task: (o: ActionOptions) => Promise<T>, message?: (r: T) => string, token?: string) => {
    const r = await act(name, task, message, { token });
    await readPublic().catch(() => undefined);
    if (mine !== undefined || demo) await readMine().catch(() => undefined);
    return r;
  };

  const poolOf = (address: Address) => info?.pools.find((p) => p.address.toLowerCase() === address.toLowerCase()) ?? null;
  const pool = info?.pools.find((p) => p.address === picked) ?? null;

  if (view === "pools") {
    return (
      <section className="vault-lp">
        <p className="vault-meta vault-lp-lede">{t("vault.lp.lede")}</p>
        {!info ? (
          <p className="vault-meta">{t("vault.lp.reading")}</p>
        ) : info.pools.length === 0 ? (
          <p className="vault-meta">{t("vault.lp.noPools")}</p>
        ) : (
          <ul className="vault-lp-pools" data-tour="lp-pools">
            {info.pools.map((p) => {
              const q = quoteOf(p);
              const here = all.filter((x) => x.pool === p.address && x.status === "open");
              const sealed0 = here.reduce((s, x) => s + x.amount0, 0n);
              const sealed1 = here.reduce((s, x) => s + x.amount1, 0n);
              return (
                <li key={p.address} className={`vault-lp-pool${picked === p.address ? " on" : ""}`}>
                  <div className="vault-lp-pair">
                    <PairIcons a={q.base.underlying.symbol} b={q.quote.underlying.symbol} />
                    <div>
                      <strong>{q.name}</strong>
                      <span className="vault-chip">{t("vault.lp.feeTier", { fee: p.fee / 10_000 })}</span>
                    </div>
                  </div>
                  <p className="vault-lp-price">{t("vault.lp.price", { base: q.base.underlying.symbol, price: fmtPrice(q.price), quote: q.quote.underlying.symbol })}</p>
                  <dl className="vault-lp-facts">
                    <div>
                      <dt>{t("vault.lp.here")}</dt>
                      <dd>{here.length}</dd>
                    </div>
                    <div>
                      <dt>{t("vault.lp.sealed")}</dt>
                      <dd>
                        {fmt(sealed0, p.token0.underlying.decimals, 2)} {p.token0.underlying.symbol} + {fmt(sealed1, p.token1.underlying.decimals, 2)} {p.token1.underlying.symbol}
                      </dd>
                    </div>
                  </dl>
                  <div className="vault-lp-pool-cta">
                    <button type="button" className="sec-btn sec-btn-small" disabled={busy} onClick={() => setPicked(picked === p.address ? null : p.address)}>
                      {t("vault.lp.provide")}
                    </button>
                    {positions.trade && (
                      <button type="button" className="sec-link" disabled={busy || !account} title={t("vault.lp.tradeHint")} onClick={() => void run("lpTrade", (o) => positions.trade!(p.address, o), () => t("vault.done.lpTrade"), pairOf(p))}>
                        {t("vault.lp.trade")}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {pool && (
          <OpenForm
            key={pool.address}
            pool={pool}
            account={account}
            busy={busy}
            connect={connect}
            onPockets={onPockets}
            onOpen={(tickLower, tickUpper, amount0, amount1, decoys) =>
              void run(
                "lpOpen",
                (o) => positions.open(pool.address, tickLower, tickUpper, amount0, amount1, { ...o, decoys }),
                (id) => t("vault.done.lpOpen", { id }),
                pairOf(pool),
              ).then((id) => id !== undefined && setPicked(null))
            }
          />
        )}

        <section className="vault-lp-all">
          <h3>{t("vault.lp.all")}</h3>
          {all.filter((p) => p.status === "open").length === 0 ? (
            <p className="vault-meta">{t("vault.lp.allEmpty")}</p>
          ) : (
            <ul className="vault-lp-rows">
              {all
                .filter((p) => p.status === "open")
                .map((p) => {
                  const pl = poolOf(p.pool);
                  return pl ? <PositionRow key={p.positionId} position={p} pool={pl} holder={<Cipher />} /> : null;
                })}
            </ul>
          )}
          <p className="vault-meta vault-lp-public">{t("vault.lp.public")}</p>
        </section>
      </section>
    );
  }

  // My positions.
  if (!account) return <div className="vault-lp-locked">{connect}</div>;
  if (mine === undefined) {
    return (
      <section className="vault-lp">
        <div className="vault-pocket-intro">
          <PoolMark />
          <h3>{t("vault.lp.unlock.title")}</h3>
          <p className="vault-meta">{t("vault.lp.unlock.body")}</p>
          <button type="button" className="sec-btn sec-btn-small" disabled={busy || !!own.busy} onClick={() => void own.run("lp", (o) => readMine(o))}>
            {own.busy ? "…" : t("vault.lp.unlock")}
          </button>
          {own.error && <p className="vault-error">{own.error.text}</p>}
        </div>
      </section>
    );
  }

  return (
    <section className="vault-lp">
      <p className="vault-meta vault-lp-lede">{t("vault.lp.mineLede")}</p>
      {mine.length === 0 ? (
        <div className="vault-pocket-intro">
          <PoolMark />
          <h3>{t("vault.lp.mineEmpty")}</h3>
          <p className="vault-meta">{t("vault.lp.mineEmptyBody")}</p>
        </div>
      ) : (
        <ul className="vault-lp-mine" data-tour="lp-mine">
          {mine.map((p) => {
            const pl = poolOf(p.pool);
            if (!pl) return null;
            return (
              <MyPosition
                key={p.positionId}
                position={p}
                pool={pl}
                account={account}
                busy={busy}
                feeBps={info?.feeBps ?? 0}
                onCollect={() => void run("lpCollect", (o) => positions.collect(p.positionId, o), () => t("vault.done.lpCollect"), pairOf(pl))}
                onAdd={(a0, a1) => void run("lpAdd", (o) => positions.add(p.positionId, a0, a1, o), () => t("vault.done.lpAdd"), pairOf(pl))}
                onRemove={(bps) => void run("lpRemove", (o) => positions.remove(p.positionId, bps, o), () => t(bps === 10_000 ? "vault.done.lpClose" : "vault.done.lpRemove"), pairOf(pl))}
                onGive={(to) => void run("lpGive", (o) => positions.give(p.positionId, to, o), () => t("vault.done.lpGive", { address: shortAddress(to) }))}
                onTakeOut={(to) => void run("lpTakeOut", (o) => positions.takeOut(p.positionId, to, o), () => t("vault.done.lpTakeOut", { address: shortAddress(to) }))}
                onSettle={(fundingId) => void run("lpSettle", (o) => positions.settle(fundingId, o), () => t("vault.done.lpSettle"))}
              />
            );
          })}
        </ul>
      )}

      <div className="vault-lp-side">
        <section className="vault-form vault-lp-receive">
          <h4>{t("vault.lp.receive")}</h4>
          <p className="vault-meta">{t("vault.lp.receiveHint")}</p>
          {receive ? (
            <p className="vault-pocket-code">
              <code>{receive}</code>
              <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" onClick={() => void navigator.clipboard?.writeText(receive)}>
                {t("vault.pocket.copy")}
              </button>
            </p>
          ) : (
            <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" disabled={busy || !!own.busy} onClick={() => void own.run("receive", async (o) => setReceive(await positions.receiveAddress(o)))}>
              {t("vault.lp.receiveShow")}
            </button>
          )}
        </section>
        <section className="vault-form vault-lp-bring">
          <h4>{t("vault.lp.bring")}</h4>
          <p className="vault-meta">{t("vault.lp.bringHint")}</p>
          {outside.length === 0 ? (
            <p className="vault-meta">{t("vault.lp.bringNone")}</p>
          ) : (
            <ul className="vault-lp-outside">
              {outside.map((w) => {
                const pl = poolOf(w.pool);
                return (
                  <li key={String(w.tokenId)}>
                    <span>
                      {pl ? quoteOf(pl).name : shortAddress(w.pool)} · #{String(w.tokenId)}
                    </span>
                    <button type="button" className="sec-btn sec-btn-small" disabled={busy} onClick={() => void run("lpDeposit", (o) => positions.deposit(w.tokenId, o), (id) => t("vault.done.lpDeposit", { id }))}>
                      {t("vault.lp.bringIt")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <p className="vault-meta vault-lp-public">{t("vault.lp.public")}</p>
    </section>
  );
}

/** The form that opens a position: a range around today's price, one amount and the other one it needs, the decoys. */
function OpenForm({
  pool,
  account,
  busy,
  connect,
  onPockets,
  onOpen,
}: {
  pool: PositionPool;
  account: Address | null;
  busy: boolean;
  connect: ReactNode;
  onPockets: () => void;
  onOpen: (tickLower: number, tickUpper: number, amount0: bigint, amount1: bigint, decoys: number) => void;
}) {
  const t = useT();
  const q = quoteOf(pool);
  const [pct, setPct] = useState<RangePct>(15);
  const [side, setSide] = useState<"base" | "quote">("base");
  const [amount, setAmount] = useState(q.base.rate > 1n ? "0.1" : "100");
  const [decoys, setDecoys] = useState(DEFAULT_POCKET_DECOYS);
  const [bad, setBad] = useState<string | null>(null);
  const range = rangeAround(pool.tick, pool.fee, pct);
  const [low, high] = q.ends(range.tickLower, range.tickUpper);

  // What the user types is one side, in the pockets' units; the other side follows the price.
  const typed = side === "base" ? q.base : q.quote;
  const other = side === "base" ? q.quote : q.base;
  const typedIs0 = (side === "base") === q.baseIs0;
  const units = parseUnits(amount, typed.decimals);
  const pairedPlain = units === null ? null : pairedAmount(pool.sqrtPriceX96, range.tickLower, range.tickUpper, typedIs0 ? 0 : 1, units * typed.rate);
  // Rounded up to the pockets' units: what is left over goes back.
  const pairedUnits = pairedPlain === null ? null : (pairedPlain + other.rate - 1n) / other.rate;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!units) return setBad(t("vault.form.bad"));
    if (pairedUnits === null) return setBad(t("vault.lp.wrongSide", { symbol: typed.underlying.symbol }));
    setBad(null);
    const [amount0, amount1] = typedIs0 ? [units, pairedUnits] : [pairedUnits, units];
    onOpen(range.tickLower, range.tickUpper, amount0, amount1, decoys);
  };

  return (
    <form className="vault-form vault-lp-open" onSubmit={submit} data-tour="lp-open">
      <h4>{t("vault.lp.openTitle", { pair: q.name, fee: pool.fee / 10_000 })}</h4>
      <div className="vault-lp-ranges" role="radiogroup" aria-label={t("vault.lp.range")}>
        <span className="vault-decoys-label">{t("vault.lp.range")}</span>
        {RANGES.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={pct === r} className={pct === r ? "on" : undefined} onClick={() => setPct(r)}>
            {r === 0 ? t("vault.lp.full") : `±${r}%`}
          </button>
        ))}
      </div>
      <RangeBar low={low} high={high} price={q.price} full={pct === 0} />
      <p className="vault-meta">
        {pct === 0
          ? t("vault.lp.fullHint")
          : t("vault.lp.rangeHint", { low: fmtPrice(low), high: fmtPrice(high), quote: q.quote.underlying.symbol, base: q.base.underlying.symbol })}
      </p>
      <div className="vault-lp-amounts">
        <label>
          <span className="vault-lp-side-pick">
            {t("vault.lp.youPut")}
            <select value={side} onChange={(e) => setSide(e.target.value as "base" | "quote")} aria-label={t("vault.lp.youPut")}>
              <option value="base">{q.base.symbol}</option>
              <option value="quote">{q.quote.symbol}</option>
            </select>
          </span>
          <span className="vault-amount-input">
            <TokenIcon symbol={typed.symbol} size={16} />
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </span>
        </label>
        <span className="vault-lp-plus" aria-hidden="true">
          +
        </span>
        <div className="vault-lp-paired">
          <span>{t("vault.lp.andNeeds")}</span>
          <strong className="with-logo">
            <TokenIcon symbol={other.symbol} size={16} />
            {pairedUnits === null ? "—" : `${fmt(pairedUnits, other.decimals)} ${other.symbol}`}
          </strong>
        </div>
      </div>
      <div className="vault-decoys vault-lp-decoys">
        <span className="vault-decoys-label" id="lp-decoys">
          {t("vault.pocket.decoys")}
        </span>
        <div role="radiogroup" aria-labelledby="lp-decoys">
          {[0, 1, 2, 3, 4].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={decoys === n} className={decoys === n ? "on" : undefined} onClick={() => setDecoys(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <ol className="vault-lp-steps">
        <li>{t("vault.lp.step1", { a: q.base.symbol, b: q.quote.symbol })}</li>
        <li>{t("vault.lp.step2")}</li>
        <li>{t("vault.lp.step3")}</li>
      </ol>
      <p className={bad ? "vault-hint vault-hint-bad" : "vault-hint"}>
        {bad ?? t("vault.lp.fromPockets", { a: q.base.symbol, b: q.quote.symbol })}{" "}
        {!bad && (
          <button type="button" className="sec-link" onClick={onPockets}>
            {t("vault.lp.toPockets")}
          </button>
        )}
      </p>
      {account ? (
        <button type="submit" className="sec-btn sec-btn-small" disabled={busy}>
          {t("vault.lp.open")}
        </button>
      ) : (
        connect
      )}
    </form>
  );
}

/** A range as a bar: its two ends, and where today's price sits. */
function RangeBar({ low, high, price, full = false }: { low: number; high: number; price: number; full?: boolean }) {
  const t = useT();
  // On a log scale, a range ±x% sits evenly around the price.
  const span = full ? 1 : Math.max(Math.log(high / low), 1e-9);
  const at = full ? 0.5 : Math.min(1, Math.max(0, Math.log(price / low) / span));
  const inRange = full || (price >= low && price < high);
  return (
    <div className={`vault-lp-bar${inRange ? " is-in" : " is-out"}`} aria-label={inRange ? t("vault.lp.inRange") : t("vault.lp.outRange")}>
      <span className="vault-lp-bar-fill" />
      <span className="vault-lp-bar-now" style={{ left: `${at * 100}%` }} />
      <span className="vault-lp-bar-end">{full ? "0" : fmtPrice(low)}</span>
      <span className="vault-lp-bar-end vault-lp-bar-end-hi">{full ? "∞" : fmtPrice(high)}</span>
    </div>
  );
}

/** A position in the vault's public list: its pool, range and amounts; its holder, a cipher. */
function PositionRow({ position, pool, holder }: { position: SealedPosition; pool: PositionPool; holder: ReactNode }) {
  const t = useT();
  const q = quoteOf(pool);
  const [low, high] = q.ends(position.tickLower, position.tickUpper);
  return (
    <li className="vault-lp-row">
      <span className="vault-lp-row-id">#{position.positionId}</span>
      <span className="vault-lp-row-pair">
        <PairIcons a={q.base.underlying.symbol} b={q.quote.underlying.symbol} small />
        {q.name}
      </span>
      <span className="vault-lp-row-range">
        {fmtPrice(low)} – {fmtPrice(high)}
      </span>
      <span>
        {fmt(position.amount0, pool.token0.underlying.decimals, 3)} {pool.token0.underlying.symbol} + {fmt(position.amount1, pool.token1.underlying.decimals, 3)} {pool.token1.underlying.symbol}
      </span>
      <span className={`vault-chip${position.inRange ? " vault-chip-on" : ""}`}>{position.inRange ? t("vault.lp.inRange") : t("vault.lp.outRange")}</span>
      <span className="vault-lp-row-holder">{holder}</span>
    </li>
  );
}

/** One of the wallet's positions, and what its holder can do with it. */
function MyPosition({
  position,
  pool,
  account,
  busy,
  feeBps,
  onCollect,
  onAdd,
  onRemove,
  onGive,
  onTakeOut,
  onSettle,
}: {
  position: SealedPosition;
  pool: PositionPool;
  account: Address;
  busy: boolean;
  feeBps: number;
  onCollect: () => void;
  onAdd: (amount0: bigint, amount1: bigint) => void;
  onRemove: (shareBps: number) => void;
  onGive: (to: Address) => void;
  onTakeOut: (to: Address) => void;
  onSettle: (fundingId: number) => void;
}) {
  const t = useT();
  const q = quoteOf(pool);
  const [low, high] = q.ends(position.tickLower, position.tickUpper);
  const [open, setOpen] = useState<"add" | "give" | "out" | null>(null);
  const [to, setTo] = useState("");
  const [addAmount, setAddAmount] = useState(q.base.rate > 1n ? "0.05" : "50");
  const [bad, setBad] = useState<string | null>(null);
  const d0 = pool.token0.underlying.decimals;
  const d1 = pool.token1.underlying.decimals;
  const s0 = pool.token0.underlying.symbol;
  const s1 = pool.token1.underlying.symbol;
  const net = (v: bigint) => v - (v * BigInt(feeBps)) / 10_000n;
  const funding = position.status === "funding";

  const add = (e: FormEvent) => {
    e.preventDefault();
    const units = parseUnits(addAmount, q.base.decimals);
    const baseIs0 = q.baseIs0;
    const paired = units === null ? null : pairedAmount(pool.sqrtPriceX96, position.tickLower, position.tickUpper, baseIs0 ? 0 : 1, units * q.base.rate);
    if (!units || paired === null) return setBad(t("vault.form.bad"));
    const pairedUnits = (paired + q.quote.rate - 1n) / q.quote.rate;
    setBad(null);
    onAdd(baseIs0 ? units : pairedUnits, baseIs0 ? pairedUnits : units);
  };
  const send = (e: FormEvent, then: (a: Address) => void) => {
    e.preventDefault();
    if (!ADDRESS.test(to.trim())) return setBad(t("vault.form.bad"));
    setBad(null);
    then(to.trim() as Address);
  };

  return (
    <li className="vault-lp-card">
      <div className="vault-lp-card-head">
        <PairIcons a={q.base.underlying.symbol} b={q.quote.underlying.symbol} />
        <div>
          <strong>{q.name}</strong>
          <span className="vault-chip">{t("vault.lp.feeTier", { fee: pool.fee / 10_000 })}</span>
          <span className="vault-meta">#{position.positionId}</span>
        </div>
        <span className={`vault-chip${funding ? "" : position.inRange ? " vault-chip-on" : " vault-chip-warn"}`}>
          {funding ? t("vault.lp.funding") : position.inRange ? t("vault.lp.inRange") : t("vault.lp.outRange")}
        </span>
      </div>
      <RangeBar low={low} high={high} price={q.price} />
      <dl className="vault-lp-facts">
        <div>
          <dt>{t("vault.lp.holds")}</dt>
          <dd>
            {fmt(position.amount0, d0)} {s0}
            <br />
            {fmt(position.amount1, d1)} {s1}
          </dd>
        </div>
        <div>
          <dt>{t("vault.lp.earned")}</dt>
          <dd className="vault-lp-earned">
            {fmt(net(position.fees0), d0, 6)} {s0}
            <br />
            {fmt(net(position.fees1), d1, 6)} {s1}
          </dd>
        </div>
      </dl>
      {funding ? (
        <div className="vault-lp-actions">
          <p className="vault-meta">{t("vault.lp.fundingHint")}</p>
          {position.pending.map((f) => (
            <button key={f} type="button" className="sec-btn sec-btn-small" disabled={busy} onClick={() => onSettle(f)}>
              {t("vault.lp.settle")}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="vault-lp-actions">
            <button type="button" className="sec-btn sec-btn-small" disabled={busy || position.fees0 + position.fees1 === 0n} onClick={onCollect}>
              {t("vault.lp.collect")}
            </button>
            <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" disabled={busy} onClick={() => setOpen(open === "add" ? null : "add")}>
              {t("vault.lp.add")}
            </button>
            <span className="vault-lp-remove" role="group" aria-label={t("vault.lp.remove")}>
              <span className="vault-decoys-label">{t("vault.lp.remove")}</span>
              {[2_500, 5_000, 10_000].map((bps) => (
                <button key={bps} type="button" className="sec-btn sec-btn-ghost sec-btn-small" disabled={busy} onClick={() => onRemove(bps)}>
                  {bps === 10_000 ? t("vault.lp.all100") : `${bps / 100}%`}
                </button>
              ))}
            </span>
            <button type="button" className="sec-link" disabled={busy} onClick={() => setOpen(open === "give" ? null : "give")}>
              {t("vault.lp.give")}
            </button>
            <button
              type="button"
              className="sec-link"
              disabled={busy}
              onClick={() => {
                setTo(account);
                setOpen(open === "out" ? null : "out");
              }}
            >
              {t("vault.lp.takeOut")}
            </button>
          </div>
          <p className="vault-meta">{t("vault.lp.collectHint", { fee: feeBps / 100 })}</p>
          {open === "add" && (
            <form className="vault-form vault-lp-inline" onSubmit={add}>
              <label>
                {t("vault.pocket.amount", { symbol: q.base.symbol })}
                <span className="vault-amount-input">
                  <TokenIcon symbol={q.base.symbol} size={16} />
                  <input value={addAmount} onChange={(e) => setAddAmount(e.target.value)} inputMode="decimal" />
                </span>
              </label>
              <p className={bad ? "vault-hint vault-hint-bad" : "vault-hint"}>{bad ?? t("vault.lp.addHint", { b: q.quote.symbol })}</p>
              <button type="submit" className="sec-btn sec-btn-small" disabled={busy}>
                {t("vault.lp.add")}
              </button>
            </form>
          )}
          {(open === "give" || open === "out") && (
            <form className="vault-form vault-lp-inline" onSubmit={(e) => send(e, open === "give" ? onGive : onTakeOut)}>
              <label>
                {open === "give" ? t("vault.lp.giveTo") : t("vault.form.to")}
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
              </label>
              <p className={bad ? "vault-hint vault-hint-bad" : "vault-hint"}>{bad ?? (open === "give" ? t("vault.lp.giveHint") : t("vault.lp.takeOutHint"))}</p>
              <button type="submit" className="sec-btn sec-btn-small" disabled={busy}>
                {open === "give" ? t("vault.lp.give") : t("vault.lp.takeOut")}
              </button>
            </form>
          )}
        </>
      )}
    </li>
  );
}

/** Two coins overlapping: a pool's pair. */
function PairIcons({ a, b, small = false }: { a: string; b: string; small?: boolean }) {
  const size = small ? 14 : 22;
  return (
    <span className={`vault-lp-icons${small ? " is-small" : ""}`} aria-hidden="true">
      <TokenIcon symbol={a} size={size} />
      <TokenIcon symbol={b} size={size} />
    </span>
  );
}

/** A sealed pool: two coins in a basin under the house's tape. */
function PoolMark() {
  return (
    <svg className="vault-pouch" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M8 34 Q32 62 56 34 Z" fill="#c99a63" stroke="#07090c" strokeWidth="2" />
      <path d="M12 36 Q22 30 32 36 T52 36" fill="none" stroke="#5be3c2" strokeWidth="2.5" />
      <circle cx="24" cy="22" r="8" fill="#5be3c2" stroke="#07090c" strokeWidth="1.5" />
      <circle cx="40" cy="18" r="8" fill="#e8d3a2" stroke="#07090c" strokeWidth="1.5" />
      <rect x="6" y="31" width="52" height="6" rx="3" fill="#e8d3a2" stroke="#07090c" strokeWidth="1.2" />
    </svg>
  );
}

const HEX = "0123456789abcdef";

/** Who holds it: hex that never settles. */
function Cipher() {
  const t = useT();
  const [text, setText] = useState("0x••••…••••");
  useEffect(() => {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const roll = () => `0x${Array.from({ length: 4 }, () => HEX[Math.floor(Math.random() * 16)]).join("")}…${Array.from({ length: 4 }, () => HEX[Math.floor(Math.random() * 16)]).join("")}`;
    const id = setInterval(() => setText(roll()), 160);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="vault-cipher" title={t("vault.item.encrypted")}>
      <span aria-hidden="true">{text}</span>
      <span className="vault-sr">{t("vault.item.encrypted")}</span>
    </span>
  );
}
