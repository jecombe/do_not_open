import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  formatAmount,
  MAX_DECOYS,
  sameAddress,
  shortAddress,
  type ActionOptions,
  type Address,
  type VaultAdapter,
  type VaultBox,
  type VaultInfo,
  type VaultOffer,
  type VaultSale,
} from "@dno/chain-adapter";
import { useAction, useChain } from "../chain/ChainProvider";
import { useLocale } from "../i18n/locale";
import { DISCORD } from "../links";
import { vaultDocsPath } from "../site";
import { SecureTop } from "../secure/SecureTop";
import { Warden } from "../secure/Warden";
import { useT } from "./i18n";
import { dismissRun, dropRun, endRun, isOwnRun, runStep, runTx, startRun } from "./tx/runStore";
import { TxDock, TxStage, useVaultRun } from "./tx/VaultTx";

/** How often the public side of the vault (its boxes, Seaport listings) is read again. */
const POLL_MS = 15_000;
const LIST_DAYS = [1, 7, 30];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Decoys a deposit sends the new box to unless the holder picks another count (0 to MAX_DECOYS). */
const DEFAULT_DECOYS = 3;
const TABS = ["explore", "mine", "wallet", "sales", "leaks"] as const;
type Tab = (typeof TABS)[number];
type Status = "all" | "listed" | "unlisted";
type Sort = "recent" | "low" | "high";
/** The box a `?box=` link opens. */
const linkedBox = (): number | null => {
  const box = new URLSearchParams(location.search).get("box");
  return box && /^\d+$/.test(box) ? Number(box) : null;
};

/**
 * The sealed vault, laid out as a marketplace that fits the screen: the collection's header and
 * numbers, tabs, filters on the side, a grid of NFTs that scrolls on its own, and each box's
 * page in a dialog. NFTs sit in boxes whose holder is encrypted, sold on Seaport with the vault
 * as the seller (a listing, or a buyer's WETH offer accepted), or privately for a secret cUSDC
 * price, and lent to a wallet through delegate.xyz. Reads go through the chain adapter only.
 */
export function VaultPage() {
  const t = useT();
  const { adapter, mode } = useChain();
  const vault = useMemo(() => adapter.vault(), [adapter]);

  useEffect(() => {
    document.title = t("vault.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("vault.description"));
  }, [t]);

  return (
    <div className="sec vault">
      <SecureTop here="vault" />
      {vault ? (
        <VaultMarket vault={vault} demo={mode === "mock"} />
      ) : (
        <div className="vault-missing">
          <p className="vault-network">{t("vault.network.missing")}</p>
          <Leaks />
        </div>
      )}
      <Warden />
    </div>
  );
}

/** The whole market: header, tabs, side filters, the grid, a box's dialog, and how actions go. */
function VaultMarket({ vault, demo }: { vault: VaultAdapter; demo: boolean }) {
  const t = useT();
  const locale = useLocale();
  const action = useAction();
  const { account, connect, connectError, picking, closePicker } = useChain();
  const [tab, setTab] = useState<Tab>(() => (location.hash === "#leaks" ? "leaks" : "explore"));
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [boxes, setBoxes] = useState<VaultBox[]>([]);
  const [mine, setMine] = useState<number[] | null>(null);
  const [nfts, setNfts] = useState<{ collection: Address; name: string; id: bigint }[]>([]);
  const [sales, setSales] = useState<VaultSale[]>([]);
  const [prices, setPrices] = useState<Record<number, bigint>>({});
  /** The action's stage is in front; folded away, the dock at the foot shows the action. */
  const [stage, setStage] = useState(false);
  const run = useVaultRun();
  const [decoys, setDecoys] = useState(DEFAULT_DECOYS);
  const [opened, setOpened] = useState<number | null>(linkedBox);
  const [status, setStatus] = useState<Status>("all");
  const [hidden, setHidden] = useState<Address[]>([]);
  const [sort, setSort] = useState<Sort>("recent");
  const [search, setSearch] = useState("");

  // The bar's "What leaks" link opens its tab.
  useEffect(() => {
    const onHash = () => location.hash === "#leaks" && setTab("leaks");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const readPublic = useCallback(async () => {
    const [i, b] = await Promise.all([vault.info(), vault.boxes()]);
    setInfo(i);
    setBoxes(b);
    return i;
  }, [vault]);

  const readAccount = useCallback(
    async (i: VaultInfo | null, findBoxes: boolean) => {
      if (!account || !i) return;
      const held = await Promise.all(i.collections.map(async (c) => (await vault.walletNfts(c.address)).map((id) => ({ collection: c.address, name: c.name, id }))));
      setNfts(held.flat());
      setSales(await vault.sales());
      if (findBoxes) setMine(await vault.myBoxes());
    },
    [vault, account],
  );

  // A new account starts unknown: finding its boxes takes a signature, except in the demo.
  useEffect(() => {
    setMine(null);
    setNfts([]);
    setSales([]);
    setPrices({});
  }, [account]);

  useEffect(() => {
    let live = true;
    const tick = () =>
      void readPublic()
        .then((i) => (live ? readAccount(i, false) : undefined))
        .catch(() => undefined);
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [readPublic, readAccount]);

  // The demo has nothing to sign: its boxes are known at once.
  useEffect(() => {
    if (demo && account && mine === null) void vault.myBoxes().then(setMine);
  }, [demo, account, mine, vault]);

  /**
   * Runs an action on the stage, its steps and transactions recorded for the dock of any page,
   * then reads everything again, the account's boxes included once found.
   */
  const act: Act = async (name, task, message) => {
    const id = startRun(name, { box: opened ?? undefined, decoys: name === "deposit" ? decoys : undefined });
    setStage(true);
    let failed = false;
    // Many actions resolve to nothing: whether the task itself went through is what tells done.
    let ok = false;
    const result = await action.run(
      name,
      async (o) => {
        const value = await task({
          ...o,
          onStep: (step) => {
            o.onStep?.(step);
            runStep(id, step);
          },
          onTx: (tx) => {
            o.onTx?.(tx);
            runTx(id, tx);
          },
        });
        ok = true;
        return value;
      },
      undefined,
      (problem) => {
        failed = true;
        endRun(id, "failed", [problem.text, problem.hints[0]].filter(Boolean).join(" "));
      },
    );
    if (ok) endRun(id, "done", message?.(result as Awaited<ReturnType<typeof task>>));
    // Neither done nor failed: the action never started (the release form came first).
    else if (!failed) {
      dropRun(id);
      setStage(false);
    }
    const i = await readPublic().catch(() => info);
    await readAccount(i, mine !== null).catch(() => undefined);
    return result;
  };

  const findMine = () => void act("find", () => vault.myBoxes()).then((m) => m && setMine(m));

  const coin = info?.coin ?? "ETH";
  const nameOf = (collection: Address) => info?.collections.find((c) => sameAddress(c.address, collection))?.name ?? shortAddress(collection);
  const labelOf = (b: VaultBox) => t("vault.nft", { collection: nameOf(b.collection), id: String(b.tokenId) });
  const inVault = boxes.filter((b) => b.state === "sealed" || b.state === "listed");
  const listed = inVault.filter((b) => b.listing && b.state === "listed");
  const floor = listed.reduce<bigint | null>((min, b) => (min === null || b.listing!.price < min ? b.listing!.price : min), null);
  const myBoxes = boxes.filter((b) => mine?.includes(b.boxId));
  const box = opened === null ? null : (boxes.find((b) => b.boxId === opened) ?? null);

  const explore = useMemo(() => {
    const q = search.trim().replace(/^#/, "");
    const shown = inVault.filter(
      (b) =>
        (status === "all" || (status === "listed") === (b.state === "listed")) &&
        !hidden.some((c) => sameAddress(c, b.collection)) &&
        (!q || String(b.tokenId).includes(q) || String(b.boxId) === q),
    );
    if (sort === "recent") return shown;
    // Unlisted boxes have no price: they go last either way.
    const price = (b: VaultBox) => (b.state === "listed" && b.listing ? b.listing.price : null);
    return [...shown].sort((a, b) => {
      const pa = price(a);
      const pb = price(b);
      if (pa === null || pb === null) return pa === null ? (pb === null ? 0 : 1) : -1;
      return (sort === "low" ? pa < pb : pa > pb) ? -1 : pa === pb ? 0 : 1;
    });
  }, [inVault, status, hidden, sort, search]);

  const counts: Record<Tab, number | null> = {
    explore: inVault.length,
    mine: mine === null ? null : myBoxes.length,
    wallet: account ? nfts.length : null,
    sales: account ? sales.length : null,
    leaks: null,
  };

  const connectButton = (
    <button type="button" className="sec-btn sec-btn-small" onClick={() => (picking ? closePicker() : void connect())} aria-expanded={!!picking}>
      {t("vault.connect")}
    </button>
  );

  return (
    <>
      <header className="vault-head">
        <div className="vault-badge" aria-hidden="true">
          <span>DNO</span>
        </div>
        <div className="vault-id">
          <h1>
            {t("vault.h1")} <span className="vault-verified" title={t("vault.network.sepolia")} aria-hidden="true" />
          </h1>
          <p>{t("vault.tagline")}</p>
        </div>
        <dl className="vault-stats">
          <div>
            <dt>{t("vault.stat.boxes")}</dt>
            <dd>{info ? inVault.length : "…"}</dd>
          </div>
          <div>
            <dt>{t("vault.stat.listed")}</dt>
            <dd>{info ? listed.length : "…"}</dd>
          </div>
          <div>
            <dt>{t("vault.stat.floor")}</dt>
            <dd>{floor === null ? "—" : `${formatAmount(floor, 18)} ${coin}`}</dd>
          </div>
          <div>
            <dt>{t("vault.stat.owners")}</dt>
            <dd>
              <Cipher length={4} />
            </dd>
          </div>
          <div>
            <dt>{t("vault.stat.fee")}</dt>
            <dd>{info ? `${info.feeBps / 100}%` : "…"}</dd>
          </div>
        </dl>
        <div className="vault-account">
          {account ? <span className="vault-me">{shortAddress(account)}</span> : connectButton}
          {!account && picking && (
            <div className="vault-wallets" role="group" aria-label={t("vault.pickWallet")}>
              <p>{t("vault.pickWallet")}</p>
              <ul>
                {picking.map((w) => (
                  <li key={w.id}>
                    <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" onClick={() => void connect(w.id)}>
                      {w.icon ? <img src={w.icon} alt="" width={20} height={20} /> : <span className="vault-wallet-blank" aria-hidden="true" />}
                      {w.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </header>

      <nav className="vault-tabs" role="tablist" aria-label={t("vault.h1")}>
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : undefined} onClick={() => setTab(k)}>
            {t(`vault.tab.${k}`)}
            {counts[k] !== null && <span className="vault-count">{counts[k]}</span>}
          </button>
        ))}
      </nav>

      <div className="vault-body">
        <aside className="vault-side">
          {tab === "explore" && (
            <>
              <fieldset>
                <legend>{t("vault.filter.status")}</legend>
                {(["all", "listed", "unlisted"] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={status === s} className={status === s ? "on" : undefined} onClick={() => setStatus(s)}>
                    {t(`vault.filter.${s}`)}
                  </button>
                ))}
              </fieldset>
              {info && info.collections.length > 0 && (
                <fieldset>
                  <legend>{t("vault.filter.collections")}</legend>
                  {info.collections.map((c) => {
                    const on = !hidden.some((h) => sameAddress(h, c.address));
                    return (
                      <label key={c.address} className="vault-check">
                        <input type="checkbox" checked={on} onChange={() => setHidden((h) => (on ? [...h, c.address] : h.filter((x) => !sameAddress(x, c.address))))} />
                        <span>{c.name}</span>
                        <span className="vault-count">{inVault.filter((b) => sameAddress(b.collection, c.address)).length}</span>
                      </label>
                    );
                  })}
                </fieldset>
              )}
            </>
          )}
          <div className="vault-side-foot">
            <p className="vault-network">{t(demo ? "vault.network.mock" : "vault.network.sepolia")}</p>
            {info && <p className="vault-network">{info.relayer ? t("vault.relayer.on") : t("vault.relayer.off")}</p>}
            <a className="sec-link" href={vaultDocsPath(locale)}>
              {t("vault.docs")}&nbsp;→
            </a>
            <a className="sec-link" href={DISCORD} target="_blank" rel="noreferrer">
              Discord&nbsp;↗
            </a>
          </div>
        </aside>

        <main className="vault-main">
          {connectError && <p className="vault-error">{connectError}</p>}

          {tab === "explore" && (
            <>
              <div className="vault-toolbar">
                <input className="vault-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("vault.search")} aria-label={t("vault.search")} />
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("vault.sort")}>
                  {(["recent", "low", "high"] as const).map((s) => (
                    <option key={s} value={s}>
                      {t(`vault.sort.${s}`)}
                    </option>
                  ))}
                </select>
                <span className="vault-results">{t("vault.results", { count: explore.length })}</span>
              </div>
              {!info ? (
                <Skeletons />
              ) : inVault.length === 0 ? (
                <Empty title={t("vault.empty.title")} body={t("vault.empty.body")}>
                  <button type="button" className="sec-btn sec-btn-small" onClick={() => setTab("wallet")}>
                    {t("vault.empty.cta")}
                  </button>
                </Empty>
              ) : explore.length === 0 ? (
                <Empty title={t("vault.filtered.empty")} />
              ) : (
                <ul className="vault-grid">
                  {explore.map((b) => (
                    <BoxCard
                      key={b.boxId}
                      box={b}
                      label={labelOf(b)}
                      coin={coin}
                      mine={!!mine?.includes(b.boxId)}
                      onOpen={() => setOpened(b.boxId)}
                      onBuy={account && !mine?.includes(b.boxId) && b.state === "listed" ? () => void act("buy", (o) => vault.buy(b.boxId, o), () => t("vault.done.buy")) : null}
                      busy={!!action.busy}
                    />
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "mine" &&
            (!account ? (
              <Empty title={t("vault.connectFirst")}>{connectButton}</Empty>
            ) : mine === null ? (
              <Empty title={t("vault.mine.lede")}>
                <button type="button" className="sec-btn sec-btn-small" disabled={!!action.busy} onClick={findMine}>
                  {t("vault.mine.find")}
                </button>
              </Empty>
            ) : myBoxes.length === 0 ? (
              <Empty title={t("vault.mine.empty")}>
                <button type="button" className="sec-btn sec-btn-small" onClick={() => setTab("wallet")}>
                  {t("vault.empty.cta")}
                </button>
              </Empty>
            ) : (
              <ul className="vault-grid">
                {myBoxes.map((b) => (
                  <BoxCard key={b.boxId} box={b} label={labelOf(b)} coin={coin} mine onOpen={() => setOpened(b.boxId)} onBuy={null} busy={!!action.busy} />
                ))}
              </ul>
            ))}

          {tab === "wallet" &&
            (!account || !info ? (
              <Empty title={t("vault.connectFirst")}>{!account && connectButton}</Empty>
            ) : (
              <>
                <div className="vault-toolbar vault-toolbar-wallet">
                  <div className="vault-decoys" role="radiogroup" aria-label={t("vault.wallet.decoys")}>
                    <span>{t("vault.wallet.decoys")}</span>
                    {Array.from({ length: MAX_DECOYS + 1 }, (_, n) => (
                      <button key={n} type="button" role="radio" aria-checked={decoys === n} className={decoys === n ? "on" : undefined} disabled={!!action.busy} onClick={() => setDecoys(n)}>
                        {n}
                      </button>
                    ))}
                  </div>
                  <p className="vault-meta">{decoys > 0 ? t("vault.wallet.decoysOn", { n: decoys }) : t("vault.wallet.decoysOff")}</p>
                </div>
                <ul className="vault-grid">
                  {info.collections
                    .filter((c) => c.mintable)
                    .map((c) => (
                      <li key={c.address} className="vault-card vault-card-mint">
                        <button type="button" disabled={!!action.busy} onClick={() => void act("mint", (o) => vault.mintTestNft(c.address, o), (id) => t("vault.done.mint", { id: String(id) }))}>
                          <span className="vault-plus" aria-hidden="true">
                            +
                          </span>
                          {t("vault.wallet.mint")}
                          <small>{c.name}</small>
                        </button>
                      </li>
                    ))}
                  {nfts.map((n) => {
                    const label = t("vault.nft", { collection: n.name, id: String(n.id) });
                    return (
                      <li key={`${n.collection}:${n.id}`} className="vault-card vault-card-open">
                        <div className="vault-art-wrap">
                          <NftArt label={label} uri={null} seed={n.id} />
                        </div>
                        <div className="vault-card-body">
                          <p className="vault-card-coll">{n.name}</p>
                          <p className="vault-card-name">#{String(n.id)}</p>
                        </div>
                        <button
                          type="button"
                          className="vault-card-cta vault-card-cta-seal"
                          disabled={!!action.busy}
                          onClick={() => void act("deposit", (o) => vault.deposit(n.collection, n.id, { ...o, decoys }), (box) => t("vault.done.deposit", { box }))}
                        >
                          {t("vault.wallet.seal")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {nfts.length === 0 && <p className="vault-empty">{t("vault.wallet.empty")}</p>}
              </>
            ))}

          {tab === "sales" &&
            (!account ? (
              <Empty title={t("vault.connectFirst")}>{connectButton}</Empty>
            ) : (
              <>
                <div className="vault-toolbar">
                  <p className="vault-meta">{t("vault.sales.lede")}</p>
                  {sales.length > 0 && (
                    <button
                      type="button"
                      className="sec-btn sec-btn-ghost sec-btn-small"
                      disabled={!!action.busy}
                      onClick={() => void act("prices", (o) => vault.salePrices(sales.map((s) => s.saleId), o)).then((p) => p && setPrices(p))}
                    >
                      {t("vault.sales.readPrices")}
                    </button>
                  )}
                </div>
                {sales.length === 0 ? (
                  <Empty title={t("vault.sales.empty")} />
                ) : (
                  <ul className="vault-sales">
                    {sales.map((s) => {
                      const toMe = sameAddress(s.buyer, account);
                      const b = boxes.find((x) => x.boxId === s.boxId);
                      return (
                        <li key={s.saleId}>
                          {b && (
                            <button type="button" className="vault-sale-art" onClick={() => setOpened(b.boxId)} aria-label={labelOf(b)}>
                              <NftArt label={labelOf(b)} uri={b.tokenUri} seed={b.tokenId} />
                            </button>
                          )}
                          <span className="vault-sale-what">{toMe ? t("vault.sales.toYou", { box: s.boxId }) : t("vault.sales.byYou", { box: s.boxId, buyer: shortAddress(s.buyer) })}</span>
                          <span className="vault-chip">{t(`vault.sale.${s.status}`)}</span>
                          <span className="vault-price">{prices[s.saleId] !== undefined ? t("vault.sales.price", { price: formatAmount(prices[s.saleId]!, 6) }) : <Cipher length={3} />}</span>
                          {s.status === "open" && toMe && (
                            <button
                              type="button"
                              className="sec-btn sec-btn-small"
                              disabled={!!action.busy}
                              onClick={() =>
                                void act("accept", (o) => vault.acceptSale(s.saleId, o), (moved) => (moved ? t("vault.sale.moved") : t("vault.sale.notMoved"))).then(async (moved) => {
                                  if (moved) setMine(await vault.myBoxes());
                                })
                              }
                            >
                              {t("vault.action.accept")}
                            </button>
                          )}
                          {s.status === "open" && !toMe && (
                            <button type="button" className="sec-btn sec-btn-ghost sec-btn-small" disabled={!!action.busy} onClick={() => void act("cancelSale", (o) => vault.cancelSale(s.saleId, o))}>
                              {t("vault.action.cancel")}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            ))}

          {tab === "leaks" && <Leaks />}
        </main>
      </div>

      {box && (
        <BoxDialog
          box={box}
          label={labelOf(box)}
          collection={nameOf(box.collection)}
          coin={coin}
          account={account}
          holder={!!mine?.includes(box.boxId)}
          busy={!!action.busy}
          act={act}
          vault={vault}
          connect={connectButton}
          onClose={() => setOpened(null)}
        />
      )}

      {stage && run && isOwnRun(run) ? (
        <TxStage
          run={run}
          onMinimize={() => setStage(false)}
          onClose={() => {
            setStage(false);
            dismissRun();
          }}
        />
      ) : (
        <TxDock onShow={() => setStage(true)} />
      )}
    </>
  );
}

/** Runs one action with its steps shown, then says how it went. */
type Act = <T>(name: string, run: (opts: ActionOptions) => Promise<T>, message?: (r: T) => string) => Promise<T | undefined>;

/** One NFT of the grid, as on a marketplace: its art under the vault's tape, its price, a button that slides up. */
function BoxCard({ box, label, coin, mine, onOpen, onBuy, busy }: { box: VaultBox; label: string; coin: string; mine: boolean; onOpen: () => void; onBuy: (() => void) | null; busy: boolean }) {
  const t = useT();
  const [collection, id] = splitLabel(label);
  return (
    <li className={`vault-card${mine ? " vault-card-mine" : ""}`}>
      <button type="button" className="vault-card-open" onClick={onOpen} aria-label={label}>
        <div className="vault-art-wrap">
          <NftArt label={label} uri={box.tokenUri} seed={box.tokenId} />
          {(box.state === "sealed" || box.state === "listed") && (
            <span className="vault-tape" aria-hidden="true">
              Do not open
            </span>
          )}
          {mine && <span className="vault-yours">{t("vault.market.yours")}</span>}
        </div>
        <div className="vault-card-body">
          <p className="vault-card-coll">{collection}</p>
          <p className="vault-card-name">{id}</p>
          {box.state === "listed" && box.listing ? (
            <p className="vault-price">{t("vault.box.price", { price: formatAmount(box.listing.price, 18), coin })}</p>
          ) : (
            <p className={`vault-state vault-state-${box.state}`}>{box.state === "sealed" ? t("vault.card.notListed") : t(`vault.state.${box.state}`)}</p>
          )}
        </div>
      </button>
      {onBuy ? (
        <button type="button" className="vault-card-cta" disabled={busy} onClick={onBuy}>
          {t("vault.action.buyNow")}
        </button>
      ) : (
        <button type="button" className="vault-card-cta vault-card-cta-ghost" tabIndex={-1} onClick={onOpen}>
          {t("vault.card.view")}
        </button>
      )}
    </li>
  );
}

/** "Mock Kittens #12" → ["Mock Kittens", "#12"]. */
function splitLabel(label: string): [string, string] {
  const at = label.lastIndexOf(" #");
  return at < 0 ? [label, ""] : [label.slice(0, at), label.slice(at + 1)];
}

/** One box's page, as a dialog: its art large on one side; its price, its holder's tools and its offers on the other. */
function BoxDialog({
  box,
  label,
  collection,
  coin,
  account,
  holder,
  busy,
  act,
  vault,
  connect,
  onClose,
}: {
  box: VaultBox;
  label: string;
  collection: string;
  coin: string;
  account: Address | null;
  holder: boolean;
  busy: boolean;
  act: Act;
  vault: VaultAdapter;
  connect: ReactNode;
  onClose: () => void;
}) {
  const t = useT();
  const [offering, setOffering] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const inVault = box.state === "sealed" || box.state === "listed";
  return (
    <div className="vault-overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vault-dialog" role="dialog" aria-modal="true" aria-label={label}>
        <button type="button" className="vault-close" onClick={onClose} aria-label={t("vault.item.close")}>
          ×
        </button>
        <div className="vault-dialog-art">
          <div className="vault-art-wrap">
            <NftArt label={label} uri={box.tokenUri} seed={box.tokenId} />
            {inVault && (
              <span className="vault-tape" aria-hidden="true">
                Do not open
              </span>
            )}
          </div>
        </div>
        <div className="vault-dialog-info">
          <p className="vault-card-coll">{collection}</p>
          <h2>{splitLabel(label)[1] || label}</h2>
          <dl className="vault-facts">
            <div>
              <dt>{t("vault.item.owner")}</dt>
              <dd>{holder ? <strong className="vault-you">{t("vault.item.you")}</strong> : <Cipher length={4} />}</dd>
            </div>
            <div>
              <dt>{t("vault.item.box")}</dt>
              <dd>#{box.boxId}</dd>
            </div>
            <div>
              <dt>{t("vault.item.sealedBy")}</dt>
              <dd>{shortAddress(box.depositor)}</dd>
            </div>
            {box.delegate && (
              <div>
                <dt>delegate.xyz</dt>
                <dd>{shortAddress(box.delegate)}</dd>
              </div>
            )}
          </dl>
          <p className="vault-meta">{holder ? t("vault.item.ownerYou") : t("vault.item.ownerHidden")}</p>

          <div className="vault-buybox">
            <p className={`vault-state vault-state-${box.state}`}>{t(`vault.state.${box.state}`)}</p>
            {box.state === "listed" && box.listing ? (
              <>
                <p className="vault-buybox-label">{t("vault.item.price")}</p>
                <p className="vault-buybox-price">{t("vault.box.price", { price: formatAmount(box.listing.price, 18), coin })}</p>
                <p className="vault-meta">{t("vault.box.until", { date: new Date(box.listing.endTime * 1000).toLocaleDateString() })}</p>
              </>
            ) : box.state === "sold" ? (
              <p className="vault-buybox-price">{t("vault.box.proceeds", { amount: formatAmount(box.proceeds, 18), coin })}</p>
            ) : (
              inVault && <p className="vault-meta">{t("vault.item.notListed")}</p>
            )}
            {!holder && inVault && (
              <div className="vault-buybox-ctas">
                {!account ? (
                  connect
                ) : (
                  <>
                    {box.state === "listed" && (
                      <button type="button" className="sec-btn" disabled={busy} onClick={() => void act("buy", (o) => vault.buy(box.boxId, o), () => t("vault.done.buy"))}>
                        {t("vault.action.buyNow")}
                      </button>
                    )}
                    <button type="button" className="sec-btn sec-btn-ghost" aria-expanded={offering} onClick={() => setOffering((o) => !o)}>
                      {t("vault.action.offer")}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {holder && account && <HolderTools box={box} coin={coin} account={account} busy={busy} act={act} vault={vault} />}

          {inVault && (
            <section className="vault-offers-wrap">
              <h3>{t("vault.action.offers")}</h3>
              <Offers box={box} coin={coin} account={account} busy={busy} act={act} vault={vault} holder={holder} offering={offering} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** What a box's holder can do with it, each action opening its own small form. */
function HolderTools({ box, coin, account, busy, act, vault }: { box: VaultBox; coin: string; account: Address; busy: boolean; act: Act; vault: VaultAdapter }) {
  const t = useT();
  const [open, setOpen] = useState<"withdraw" | "list" | "claim" | "delegate" | "send" | "sell" | "adopt" | null>(null);
  const toggle = (what: typeof open) => setOpen((cur) => (cur === what ? null : what));
  /** The box's own actions fold their form away once they went through. */
  const run: Act = async (name, task, message) => {
    let ok = false;
    const result = await act(
      name,
      async (o) => {
        const value = await task(o);
        ok = true;
        return value;
      },
      message,
    );
    if (ok) setOpen(null);
    return result;
  };
  const actions: { key: NonNullable<typeof open> | "unlist"; when: boolean }[] = [
    { key: "list", when: box.state === "sealed" },
    { key: "unlist", when: box.state === "listed" },
    { key: "claim", when: box.state === "sold" },
    { key: "withdraw", when: box.state === "sealed" || box.state === "listed" },
    { key: "delegate", when: box.state === "sealed" || box.state === "listed" },
    { key: "sell", when: box.state === "sealed" },
    { key: "send", when: box.state === "sealed" },
    { key: "adopt", when: box.state === "sealed" },
  ];
  const shown = actions.filter((a) => a.when);
  if (shown.length === 0) return null;

  return (
    <section className="vault-tools">
      {box.busy && <p className="vault-meta">{t("vault.box.busy")}</p>}
      <div className="vault-actions">
        {shown.map((a, i) =>
          a.key === "unlist" ? (
            <button key={a.key} type="button" className="sec-btn sec-btn-ghost sec-btn-small" disabled={busy} onClick={() => void run("unlist", (o) => vault.unlist(box.boxId, o), () => t("vault.done.unlist"))}>
              {t("vault.action.unlist")}
            </button>
          ) : (
            <button
              key={a.key}
              type="button"
              className={`sec-btn sec-btn-small${i === 0 ? "" : " sec-btn-ghost"}`}
              aria-expanded={open === a.key}
              disabled={busy}
              onClick={() => toggle(a.key as typeof open)}
            >
              {t(`vault.action.${a.key}`)}
            </button>
          ),
        )}
      </div>
      {open === "withdraw" && (
        <AddressForm account={account} hint={t("vault.form.toHint")} busy={busy} onSubmit={(to) => void run("withdraw", (o) => vault.withdraw(box.boxId, to, o), () => t("vault.done.withdraw", { address: shortAddress(to) }))} />
      )}
      {open === "claim" && (
        <AddressForm
          account={account}
          hint={t("vault.form.toHint")}
          busy={busy}
          onSubmit={(to) => void run("claim", (o) => vault.claim(box.boxId, to, o), (amount) => t("vault.done.claim", { amount: formatAmount(amount, 18), coin, address: shortAddress(to) }))}
        />
      )}
      {open === "delegate" && (
        <>
          <AddressForm
            account={null}
            hint={t("vault.form.delegateHint")}
            busy={busy}
            onSubmit={(to) => void run("delegate", (o) => vault.delegate(box.boxId, to, o), () => t("vault.done.delegate", { address: shortAddress(to) }))}
          />
          {box.delegate && (
            <button type="button" className="sec-link" disabled={busy} onClick={() => void run("delegate", (o) => vault.delegate(box.boxId, null, o), () => t("vault.done.clearDelegate"))}>
              {t("vault.action.clearDelegate")}
            </button>
          )}
        </>
      )}
      {open === "send" && <AddressForm account={null} hint={t("vault.form.sendHint")} busy={busy} onSubmit={(to) => void run("send", (o) => vault.send(box.boxId, to, o), () => t("vault.done.send"))} />}
      {open === "list" && <ListForm coin={coin} busy={busy} onSubmit={(price, endTime) => void run("list", (o) => vault.list(box.boxId, price, endTime, o), () => t("vault.done.list"))} />}
      {open === "sell" && <SellForm busy={busy} onSubmit={(buyer, price) => void run("sell", (o) => vault.offerSale(box.boxId, buyer, price, o), () => t("vault.done.sell"))} />}
      {open === "adopt" && (
        <Form busy={busy} hint={t("vault.form.adoptHint")} onSubmit={() => void run("adopt", (o) => vault.adopt(box.boxId, o), () => t("vault.done.adopt"))}>
          {null}
        </Form>
      )}
    </section>
  );
}

/**
 * The offers on one box, read when its page opens. Its holder picks one and where the ETH goes;
 * anyone else sees them, cancels their own, and makes one.
 */
function Offers({
  box,
  coin,
  account,
  busy,
  act,
  vault,
  holder,
  offering,
}: {
  box: VaultBox;
  coin: string;
  account: Address | null;
  busy: boolean;
  act: Act;
  vault: VaultAdapter;
  holder: boolean;
  offering: boolean;
}) {
  const t = useT();
  const [offers, setOffers] = useState<VaultOffer[] | null>(null);
  const [chosen, setChosen] = useState<VaultOffer | null>(null);
  const read = useCallback(() => void vault.offers(box.boxId).then(setOffers, () => setOffers([])), [vault, box.boxId]);
  useEffect(read, [read]);
  const date = (s: number) => new Date(s * 1000).toLocaleDateString();
  return (
    <div className="vault-offers">
      {!holder && account && offering && <OfferForm busy={busy} onSubmit={(amount, endTime) => void act("offer", (opts) => vault.makeOffer(box.boxId, amount, endTime, opts), () => t("vault.done.offer")).then(read)} />}
      {offers === null ? (
        <p className="vault-meta">{t("vault.offers.loading")}</p>
      ) : offers.length === 0 ? (
        <p className="vault-meta">{t("vault.offers.empty")}</p>
      ) : (
        <ul>
          {offers.map((o) => (
            <li key={o.orderHash} className={chosen?.orderHash === o.orderHash ? "on" : undefined}>
              <span>
                {t("vault.offers.row", { amount: formatAmount(o.amount, 18), coin, buyer: shortAddress(o.buyer), date: date(o.endTime) })}
                {o.anyToken && <span className="vault-chip">{t("vault.offers.any")}</span>}
              </span>
              {holder && (
                <button type="button" className="sec-btn sec-btn-small" aria-pressed={chosen?.orderHash === o.orderHash} disabled={busy} onClick={() => setChosen(o)}>
                  {t("vault.action.acceptOffer")}
                </button>
              )}
              {!holder && account && sameAddress(o.buyer, account) && (
                <button
                  type="button"
                  className="sec-btn sec-btn-ghost sec-btn-small"
                  disabled={busy}
                  onClick={() => void act("cancelOffer", (opts) => vault.cancelOffer(o.orderHash, opts), () => t("vault.done.cancelOffer")).then(read)}
                >
                  {t("vault.action.cancel")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {holder && chosen && account && (
        <AddressForm
          account={account}
          hint={t("vault.offers.acceptHint", { amount: formatAmount(chosen.amount, 18), coin })}
          busy={busy}
          onSubmit={(to) =>
            void act("acceptOffer", (opts) => vault.acceptOffer(box.boxId, chosen.orderHash, to, opts), (amount) =>
              t("vault.done.acceptOffer", { amount: formatAmount(amount, 18), coin, address: shortAddress(to) }),
            )
          }
        />
      )}
    </div>
  );
}

function OfferForm({ busy, onSubmit }: { busy: boolean; onSubmit: (amount: bigint, endTime: number) => void }) {
  const t = useT();
  const [amount, setAmount] = useState("0.01");
  const [days, setDays] = useState(7);
  const [bad, setBad] = useState(false);
  return (
    <Form
      busy={busy}
      hint={bad ? t("vault.form.bad") : t("vault.form.offerHint")}
      onSubmit={() => {
        const wei = parseUnits(amount, 18);
        setBad(!wei);
        if (wei) onSubmit(wei, Math.floor(Date.now() / 1000) + days * 86_400);
      }}
    >
      <label>
        {t("vault.form.offer")}
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        {t("vault.form.days")}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {LIST_DAYS.map((d) => (
            <option key={d} value={d}>
              {t("vault.form.days", { count: d })}
            </option>
          ))}
        </select>
      </label>
    </Form>
  );
}

function Form({ busy, hint, onSubmit, children }: { busy: boolean; hint?: string; onSubmit: () => void; children: ReactNode }) {
  const t = useT();
  return (
    <form
      className="vault-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      {hint && <p className="vault-hint">{hint}</p>}
      <button type="submit" className="sec-btn sec-btn-small" disabled={busy}>
        {t("vault.action.go")}
      </button>
    </form>
  );
}

function AddressForm({ account, hint, busy, onSubmit }: { account: Address | null; hint: string; busy: boolean; onSubmit: (to: Address) => void }) {
  const t = useT();
  const [to, setTo] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <Form
      busy={busy}
      hint={bad ? t("vault.form.bad") : hint}
      onSubmit={() => {
        const ok = ADDRESS.test(to.trim());
        setBad(!ok);
        if (ok) onSubmit(to.trim());
      }}
    >
      <label>
        {t("vault.form.to")}
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
      </label>
      {account && (
        <button type="button" className="sec-link" onClick={() => setTo(account)}>
          {t("vault.form.toMe")}
        </button>
      )}
    </Form>
  );
}

function ListForm({ coin, busy, onSubmit }: { coin: string; busy: boolean; onSubmit: (price: bigint, endTime: number) => void }) {
  const t = useT();
  const [price, setPrice] = useState("0.01");
  const [days, setDays] = useState(7);
  const [bad, setBad] = useState(false);
  return (
    <Form
      busy={busy}
      hint={bad ? t("vault.form.bad") : undefined}
      onSubmit={() => {
        const wei = parseUnits(price, 18);
        setBad(wei === null || wei === 0n);
        if (wei) onSubmit(wei, Math.floor(Date.now() / 1000) + days * 86_400);
      }}
    >
      <label>
        {t("vault.form.price", { coin })}
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        {t("vault.form.days")}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {LIST_DAYS.map((d) => (
            <option key={d} value={d}>
              {t("vault.form.days", { count: d })}
            </option>
          ))}
        </select>
      </label>
    </Form>
  );
}

function SellForm({ busy, onSubmit }: { busy: boolean; onSubmit: (buyer: Address, price: bigint) => void }) {
  const t = useT();
  const [buyer, setBuyer] = useState("");
  const [price, setPrice] = useState("10");
  const [bad, setBad] = useState(false);
  return (
    <Form
      busy={busy}
      hint={bad ? t("vault.form.bad") : t("vault.form.sellHint")}
      onSubmit={() => {
        const units = parseUnits(price, 6);
        const ok = ADDRESS.test(buyer.trim()) && !!units;
        setBad(!ok);
        if (ok) onSubmit(buyer.trim(), units!);
      }}
    >
      <label>
        {t("vault.form.buyer")}
        <input value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
      </label>
      <label>
        {t("vault.form.usdc")}
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
      </label>
    </Form>
  );
}

/** A grid's empty state: a closed carton, a line, and what to do. */
function Empty({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="vault-emptybox">
      <div className="vault-carton" aria-hidden="true">
        <span>Do not open</span>
      </div>
      <p className="vault-emptybox-title">{title}</p>
      {body && <p className="vault-meta">{body}</p>}
      {children}
    </div>
  );
}

/** Grey cards while the vault is first read. */
function Skeletons() {
  return (
    <ul className="vault-grid" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="vault-card vault-skeleton" />
      ))}
    </ul>
  );
}

const HEX = "0123456789abcdef";

/** An encrypted value: hex that never settles. Still, for whoever asked for less motion. */
function Cipher({ length }: { length: number }) {
  const t = useT();
  const still = useMemo(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const roll = () => `0x${Array.from({ length }, () => HEX[Math.floor(Math.random() * 16)]).join("")}…${Array.from({ length }, () => HEX[Math.floor(Math.random() * 16)]).join("")}`;
  const [text, setText] = useState(roll);
  useEffect(() => {
    if (still) return;
    const id = setInterval(() => setText(roll()), 140);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still, length]);
  return (
    <span className="vault-cipher" title={t("vault.item.encrypted")}>
      <span aria-hidden="true">{still ? `0x${"•".repeat(length)}…${"•".repeat(length)}` : text}</span>
      <span className="vault-sr">{t("vault.item.encrypted")}</span>
    </span>
  );
}

/** The NFT's own picture when its metadata carries one inline, a seeded pattern otherwise. */
function NftArt({ label, uri, seed }: { label: string; uri: string | null; seed: bigint }) {
  const image = useMemo(() => inlineImage(uri), [uri]);
  if (image) return <img className="vault-art" src={image} alt={label} loading="lazy" />;
  return <Pattern label={label} seed={seed} />;
}

/** A small seeded drawing for NFTs without an inline image: two hues, a few shapes, the number. */
function Pattern({ label, seed }: { label: string; seed: bigint }) {
  const shapes = useMemo(() => {
    let s = Number(seed % 2_147_483_647n) || 1;
    const rand = () => {
      s = (s * 16_807) % 2_147_483_647;
      return s / 2_147_483_647;
    };
    const hue = Math.floor(rand() * 360);
    const hue2 = (hue + 60 + Math.floor(rand() * 120)) % 360;
    const dots = Array.from({ length: 6 }, () => ({ x: rand() * 100, y: rand() * 100, r: 6 + rand() * 22, o: 0.18 + rand() * 0.4, c: rand() > 0.5 ? hue2 : hue }));
    return { hue, hue2, dots };
  }, [seed]);
  const id = `g${String(seed)}`;
  return (
    <svg className="vault-art" viewBox="0 0 100 100" role="img" aria-label={label} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${shapes.hue} 65% 58%)`} />
          <stop offset="1" stopColor={`hsl(${shapes.hue2} 60% 32%)`} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#${id})`} />
      {shapes.dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={`hsl(${d.c} 80% 75%)`} opacity={d.o} />
      ))}
      <text x="50" y="58" textAnchor="middle" fontFamily="ui-monospace, monospace" fontWeight="700" fontSize="16" fill="rgb(7 9 12 / 0.7)">
        #{String(seed).slice(-6)}
      </text>
    </svg>
  );
}

/** The image of a `data:application/json;base64` token URI, as on-chain collections write them. */
function inlineImage(uri: string | null): string | null {
  const prefix = "data:application/json;base64,";
  if (!uri?.startsWith(prefix)) return null;
  try {
    const json = JSON.parse(atob(uri.slice(prefix.length))) as { image?: unknown };
    return typeof json.image === "string" && (json.image.startsWith("data:image/") || json.image.startsWith("https://")) ? json.image : null;
  } catch {
    return null;
  }
}

/** "0.01" at 18 decimals to wei; null when it is not a plain positive decimal. */
function parseUnits(value: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m || (m[2]?.length ?? 0) > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

/** Why the vault, then what shows and what does not, side by side. */
function Leaks() {
  const t = useT();
  return (
    <section className="vault-leaks" id="leaks">
      <p className="vault-meta vault-leaks-lede">{t("vault.lede")}</p>
      <ol className="vault-why">
        {(["1", "2", "3", "4"] as const).map((n) => (
          <li key={n}>
            <strong>{t(`vault.why${n}.title`)}</strong> {t(`vault.why${n}.body`)}
          </li>
        ))}
      </ol>
      <div className="vault-leaks-cols">
        <div>
          <h3>{t("vault.leaks.public")}</h3>
          <ul>
            {(["1", "2", "3", "4", "5"] as const).map((n) => (
              <li key={n}>{t(`vault.leaks.public${n}`)}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{t("vault.leaks.hidden")}</h3>
          <ul>
            {(["1", "2", "3", "4"] as const).map((n) => (
              <li key={n}>{t(`vault.leaks.hidden${n}`)}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
