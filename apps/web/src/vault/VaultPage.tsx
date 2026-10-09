import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { formatAmount, sameAddress, shortAddress, type ActionOptions, type Address, type VaultAdapter, type VaultBox, type VaultInfo, type VaultSale } from "@dno/chain-adapter";
import { useAction, useChain } from "../chain/ChainProvider";
import { useLocale } from "../i18n/locale";
import { DISCORD } from "../links";
import { vaultDocsPath } from "../site";
import { SecureTop } from "../secure/SecureTop";
import { useT } from "./i18n";

/** How often the public side of the vault (its boxes, Seaport listings) is read again. */
const POLL_MS = 15_000;
const LIST_DAYS = [1, 7, 30];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The sealed vault: NFTs in boxes whose holder is encrypted, sold on Seaport with the vault as
 * the seller, or privately for a secret cUSDC price. Reads go through the chain adapter only.
 */
export function VaultPage() {
  const t = useT();
  const locale = useLocale();
  const { adapter, mode, account, connect, connectError } = useChain();
  const vault = useMemo(() => adapter.vault(), [adapter]);

  useEffect(() => {
    document.title = t("vault.title");
    document.querySelector('meta[name="description"]')?.setAttribute("content", t("vault.description"));
  }, [t]);

  return (
    <div className="sec vault">
      <SecureTop here="vault" />

      <section className="vault-hero">
        <p className="sec-kicker">{t("vault.kicker")}</p>
        <h1>{t("vault.h1")}</h1>
        <p className="sec-lede">{t("vault.lede")}</p>
        <ol className="vault-why">
          {(["1", "2", "3"] as const).map((n) => (
            <li key={n}>
              <strong>{t(`vault.why${n}.title`)}</strong> {t(`vault.why${n}.body`)}
            </li>
          ))}
        </ol>
        <a className="sec-link" href={vaultDocsPath(locale)}>
          {t("vault.docs")}&nbsp;→
        </a>
        <p className="vault-network">{vault ? t(mode === "mock" ? "vault.network.mock" : "vault.network.sepolia") : t("vault.network.missing")}</p>
        {!account && (
          <p className="sec-ctas">
            <button type="button" className="sec-btn" onClick={() => void connect()}>
              {t("vault.connect")}
            </button>
          </p>
        )}
        {connectError && <p className="vault-error">{connectError}</p>}
      </section>

      {vault && <VaultDesk vault={vault} account={account} demo={mode === "mock"} />}

      <Leaks />


      <footer className="sec-foot">
        <span>DO NOT OPEN</span>
        <a href={DISCORD} target="_blank" rel="noreferrer">
          Discord
        </a>
      </footer>
    </div>
  );
}

/** Everything that needs the vault: the wallet's NFTs, the account's boxes, Seaport, private sales. */
function VaultDesk({ vault, account, demo }: { vault: VaultAdapter; account: Address | null; demo: boolean }) {
  const t = useT();
  const action = useAction();
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [boxes, setBoxes] = useState<VaultBox[]>([]);
  const [mine, setMine] = useState<number[] | null>(null);
  const [nfts, setNfts] = useState<{ collection: Address; name: string; id: bigint }[]>([]);
  const [sales, setSales] = useState<VaultSale[]>([]);
  const [prices, setPrices] = useState<Record<number, bigint>>({});
  const [done, setDone] = useState<string | null>(null);

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

  /** Runs an action, then reads everything again, the account's boxes included once found. */
  const act: Act = async (name, run, message) => {
    setDone(null);
    const result = await action.run(name, run);
    const i = await readPublic().catch(() => info);
    await readAccount(i, mine !== null).catch(() => undefined);
    if (result !== undefined && message) setDone(message(result));
    return result;
  };

  const coin = info?.coin ?? "ETH";
  const byId = new Map(boxes.map((b) => [b.boxId, b]));
  const nameOf = (collection: Address) => info?.collections.find((c) => sameAddress(c.address, collection))?.name ?? shortAddress(collection);
  const listed = boxes.filter((b) => b.state === "listed" && b.listing);
  const myBoxes = (mine ?? []).flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));

  return (
    <>
      {info && <p className="vault-relayer">{info.relayer ? t("vault.relayer.on") : t("vault.relayer.off")}</p>}
      <div className="vault-status" aria-live="polite">
        {action.busy && <p className="vault-step">{t(`vault.step.${action.step ?? "wallet"}`)}…</p>}
        {action.error && (
          <p className="vault-error">
            {action.error.text} {action.error.hints[0]}
          </p>
        )}
        {done && <p className="vault-done">{done}</p>}
      </div>

      {account && info && (
        <section className="vault-panel">
          <h2>{t("vault.wallet.title")}</h2>
          <p className="vault-lede">{t("vault.wallet.lede")}</p>
          {nfts.length === 0 && <p className="vault-empty">{t("vault.wallet.empty")}</p>}
          <ul className="vault-grid">
            {nfts.map((n) => (
              <li key={`${n.collection}:${n.id}`} className="vault-card">
                <NftArt label={t("vault.nft", { collection: n.name, id: String(n.id) })} uri={null} seed={n.id} />
                <p className="vault-card-name">{t("vault.nft", { collection: n.name, id: String(n.id) })}</p>
                <button
                  type="button"
                  className="sec-btn sec-btn-small"
                  disabled={!!action.busy}
                  onClick={() => void act("deposit", (o) => vault.deposit(n.collection, n.id, o), (box) => t("vault.done.deposit", { box }))}
                >
                  {t("vault.wallet.seal")}
                </button>
              </li>
            ))}
          </ul>
          {info.collections
            .filter((c) => c.mintable)
            .map((c) => (
              <button
                key={c.address}
                type="button"
                className="sec-btn sec-btn-ghost sec-btn-small"
                disabled={!!action.busy}
                onClick={() => void act("mint", (o) => vault.mintTestNft(c.address, o), (id) => t("vault.done.mint", { id: String(id) }))}
              >
                {t("vault.wallet.mint")}
              </button>
            ))}
        </section>
      )}

      {account && info && (
        <section className="vault-panel">
          <h2>{t("vault.mine.title")}</h2>
          <p className="vault-lede">{t("vault.mine.lede")}</p>
          {mine === null ? (
            <button type="button" className="sec-btn sec-btn-small" disabled={!!action.busy} onClick={() => void act("find", () => vault.myBoxes()).then((m) => m && setMine(m))}>
              {t("vault.mine.find")}
            </button>
          ) : myBoxes.length === 0 ? (
            <p className="vault-empty">{t("vault.mine.empty")}</p>
          ) : (
            <ul className="vault-grid">
              {myBoxes.map((b) => (
                <MyBox key={b.boxId} box={b} coin={coin} name={nameOf(b.collection)} account={account} busy={!!action.busy} act={act} vault={vault} />
              ))}
            </ul>
          )}
        </section>
      )}

      {info && (
        <section className="vault-panel">
          <h2>{t("vault.market.title")}</h2>
          <p className="vault-lede">{t("vault.market.lede")}</p>
          {listed.length === 0 && <p className="vault-empty">{t("vault.market.empty")}</p>}
          <ul className="vault-grid">
            {listed.map((b) => (
              <li key={b.boxId} className="vault-card">
                <NftArt label={t("vault.nft", { collection: nameOf(b.collection), id: String(b.tokenId) })} uri={b.tokenUri} seed={b.tokenId} />
                <p className="vault-card-name">{t("vault.nft", { collection: nameOf(b.collection), id: String(b.tokenId) })}</p>
                <p className="vault-price">{t("vault.box.price", { price: formatAmount(b.listing!.price, 18), coin })}</p>
                <p className="vault-meta">{t("vault.box.until", { date: new Date(b.listing!.endTime * 1000).toLocaleDateString() })}</p>
                {mine?.includes(b.boxId) ? (
                  <span className="vault-chip">{t("vault.market.yours")}</span>
                ) : (
                  account && (
                    <button type="button" className="sec-btn sec-btn-small" disabled={!!action.busy} onClick={() => void act("buy", (o) => vault.buy(b.boxId, o), () => t("vault.done.buy"))}>
                      {t("vault.action.buy")}
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {account && info && (
        <section className="vault-panel">
          <h2>{t("vault.sales.title")}</h2>
          <p className="vault-lede">{t("vault.sales.lede")}</p>
          {sales.length === 0 ? (
            <p className="vault-empty">{t("vault.sales.empty")}</p>
          ) : (
            <>
              <ul className="vault-sales">
                {sales.map((s) => {
                  const toMe = sameAddress(s.buyer, account);
                  return (
                    <li key={s.saleId}>
                      <span>{toMe ? t("vault.sales.toYou", { box: s.boxId }) : t("vault.sales.byYou", { box: s.boxId, buyer: shortAddress(s.buyer) })}</span>
                      <span className="vault-chip">{t(`vault.sale.${s.status}`)}</span>
                      {prices[s.saleId] !== undefined && <span className="vault-price">{t("vault.sales.price", { price: formatAmount(prices[s.saleId]!, 6) })}</span>}
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
              <button
                type="button"
                className="sec-btn sec-btn-ghost sec-btn-small"
                disabled={!!action.busy}
                onClick={() => void act("prices", (o) => vault.salePrices(sales.map((s) => s.saleId), o)).then((p) => p && setPrices(p))}
              >
                {t("vault.sales.readPrices")}
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}

/** Runs one action with its steps shown, then says how it went. */
type Act = <T>(name: string, run: (opts: ActionOptions) => Promise<T>, message?: (r: T) => string) => Promise<T | undefined>;

/** One of the account's boxes, with what its holder can do. */
function MyBox({ box, coin, name, account, busy, act, vault }: { box: VaultBox; coin: string; name: string; account: Address; busy: boolean; act: Act; vault: VaultAdapter }) {
  const t = useT();
  const [open, setOpen] = useState<"withdraw" | "list" | "claim" | "send" | "sell" | "adopt" | null>(null);
  const label = t("vault.nft", { collection: name, id: String(box.tokenId) });
  const toggle = (what: typeof open) => setOpen((cur) => (cur === what ? null : what));
  /** The box's own actions fold their form away once they went through. */
  const run: Act = async (name, task, message) => {
    const result = await act(name, task, message);
    if (result !== undefined) setOpen(null);
    return result;
  };
  const actions: { key: NonNullable<typeof open> | "unlist"; when: boolean }[] = [
    { key: "withdraw", when: box.state === "sealed" || box.state === "listed" },
    { key: "list", when: box.state === "sealed" },
    { key: "unlist", when: box.state === "listed" },
    { key: "claim", when: box.state === "sold" },
    { key: "sell", when: box.state === "sealed" },
    { key: "send", when: box.state === "sealed" },
    { key: "adopt", when: box.state === "sealed" },
  ];

  return (
    <li className="vault-card vault-card-mine">
      <NftArt label={label} uri={box.tokenUri} seed={box.tokenId} />
      <p className="vault-card-name">{label}</p>
      <p className={`vault-state vault-state-${box.state}`}>{t(`vault.state.${box.state}`)}</p>
      {box.listing && box.state === "listed" && <p className="vault-price">{t("vault.box.price", { price: formatAmount(box.listing.price, 18), coin })}</p>}
      {box.state === "sold" && <p className="vault-price">{t("vault.box.proceeds", { amount: formatAmount(box.proceeds, 18), coin })}</p>}
      {box.busy && <p className="vault-meta">{t("vault.box.busy")}</p>}
      <div className="vault-actions">
        {actions
          .filter((a) => a.when)
          .map((a) =>
            a.key === "unlist" ? (
              <button key={a.key} type="button" className="sec-btn sec-btn-ghost sec-btn-small" disabled={busy} onClick={() => void run("unlist", (o) => vault.unlist(box.boxId, o), () => t("vault.done.unlist"))}>
                {t("vault.action.unlist")}
              </button>
            ) : (
              <button key={a.key} type="button" className="sec-btn sec-btn-ghost sec-btn-small" aria-expanded={open === a.key} disabled={busy} onClick={() => toggle(a.key as typeof open)}>
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
      {open === "send" && (
        <AddressForm account={null} hint={t("vault.form.sendHint")} busy={busy} onSubmit={(to) => void run("send", (o) => vault.send(box.boxId, to, o), () => t("vault.done.send"))} />
      )}
      {open === "list" && <ListForm coin={coin} busy={busy} onSubmit={(price, endTime) => void run("list", (o) => vault.list(box.boxId, price, endTime, o), () => t("vault.done.list"))} />}
      {open === "sell" && <SellForm busy={busy} onSubmit={(buyer, price) => void run("sell", (o) => vault.offerSale(box.boxId, buyer, price, o), () => t("vault.done.sell"))} />}
      {open === "adopt" && (
        <Form busy={busy} hint={t("vault.form.adoptHint")} onSubmit={() => void run("adopt", (o) => vault.adopt(box.boxId, o), () => t("vault.done.adopt"))}>
          {null}
        </Form>
      )}
    </li>
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

/** The NFT's own picture when its metadata carries one inline, a stamped carton otherwise. */
function NftArt({ label, uri, seed }: { label: string; uri: string | null; seed: bigint }) {
  const image = useMemo(() => inlineImage(uri), [uri]);
  if (image) return <img className="vault-art" src={image} alt={label} />;
  const hue = Number(seed % 360n);
  return (
    <div className="vault-art vault-art-blank" style={{ background: `hsl(${hue} 70% 62%)` }} aria-label={label} role="img">
      <span>#{String(seed).slice(-6)}</span>
    </div>
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

/** What shows and what does not, side by side. */
function Leaks() {
  const t = useT();
  return (
    <section className="vault-panel vault-leaks" id="leaks">
      <h2>{t("vault.leaks.title")}</h2>
      <div className="vault-leaks-cols">
        <div>
          <h3>{t("vault.leaks.public")}</h3>
          <ul>
            {(["1", "2", "3", "4"] as const).map((n) => (
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

