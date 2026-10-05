import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatAmount,
  sameAddress,
  shortAddress,
  type BoxInfo,
  type FleaMarketInfo,
  type Listing,
  type MarketCollection,
  type MarketOffer,
  type RatInfo,
  type TraitRoll,
} from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import { bumpLedger, useAction, useChain, useLedger } from "../chain/ChainProvider";
import { catFromRevealed, traitCopy } from "../chain/copy";
import { usePayment } from "../chain/payment";
import { useLive } from "../chain/useLive";
import { useT, type AppKey } from "../i18n/app";
import { useLocale } from "../i18n/locale";
import { cap, catNames } from "../i18n/names";
import { studioPath } from "../site";
import { parseAmount } from "../views/PantryView";
import { PayLine } from "../views/PayWith";
import { ProblemNote } from "../views/ProblemNote";
import { TxPending } from "../views/TxPending";
import { boxArt, ratArt } from "./art";
import { Confetti } from "./Confetti";
import "./market.css";

/** What a buyer sees on the tag: a sealed box, the cat an opened one showed, or a rat. */
type Kind = "box" | "cat" | "rat";
type Filter = "all" | Kind | "mine";
type Sort = "new" | "cheap" | "dear";

const FILTERS: { key: Filter; label: AppKey }[] = [
  { key: "all", label: "fm.filter.all" },
  { key: "box", label: "fm.filter.boxes" },
  { key: "cat", label: "fm.filter.cats" },
  { key: "rat", label: "fm.filter.rats" },
  { key: "mine", label: "fm.filter.mine" },
];

const KIND_LABEL: Record<Kind, AppKey> = { box: "fm.kind.box", cat: "fm.kind.cat", rat: "fm.kind.rat" };
const QUICK_PRICES = ["5", "10", "25", "50"];
const DECIMALS = 6;

const money = (v: bigint) => {
  const [whole, frac = ""] = formatAmount(v, DECIMALS).split(".");
  return frac ? `${Number(whole).toLocaleString("en-US")}.${frac.slice(0, 2).padEnd(2, "0")}` : Number(whole).toLocaleString("en-US");
};

interface Props {
  /** The shelf, where boxes are ordered. */
  onShop: () => void;
  /** One box up close. */
  onInspect: (tokenId: number) => void;
}

/**
 * The flea market: players sell each other sealed boxes, cats and rats in cUSDC, at a public
 * asking price or to a secret offer whose amount only the two sides can read. Each item hangs
 * under its own little awning; picking one opens its booth.
 */
export function MarketView({ onShop, onInspect }: Props) {
  const t = useT();
  const locale = useLocale();
  const { adapter, account, connect } = useChain();
  const ledger = useLedger();
  const [info, setInfo] = useState<FleaMarketInfo | null | undefined>(undefined);
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [boxes, setBoxes] = useState<Map<number, BoxInfo>>(new Map());
  const [rats, setRats] = useState<Map<number, RatInfo>>(new Map());
  const [myOffers, setMyOffers] = useState<MarketOffer[]>([]);
  const [received, setReceived] = useState<MarketOffer[]>([]);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("new");
  const [open, setOpen] = useState<number | null>(null);
  const [selling, setSelling] = useState(false);
  const [party, setParty] = useState<{ key: number; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    adapter.fleaMarket().then(
      (m) => live && setInfo(m),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [adapter]);

  const load = useCallback(
    async (live: () => boolean) => {
      try {
        const all = await adapter.listings();
        // Only what is on screen needs its item read: what is for sale, and the last sales.
        const wanted = all.filter((l) => l.status === "active" || l.status === "pending" || l.status === "sold").slice(0, 120);
        const [boxRows, ratRows] = await Promise.all([
          Promise.all(wanted.filter((l) => l.collection === "boxes").map((l) => adapter.box(l.tokenId).catch(() => null))),
          Promise.all(wanted.filter((l) => l.collection === "rats").map((l) => adapter.rat(l.tokenId).catch(() => null))),
        ]);
        const [mine, toMe] = account
          ? await Promise.all([adapter.offers({ buyer: account }), adapter.offers({ seller: account, status: "open" })])
          : [[], []];
        if (!live()) return;
        setListings(all);
        setBoxes(new Map(boxRows.flatMap((b) => (b ? [[b.tokenId, b] as const] : []))));
        setRats(new Map(ratRows.flatMap((r) => (r ? [[r.id, r] as const] : []))));
        setMyOffers(mine);
        setReceived(toMe);
        setFailed(false);
      } catch {
        if (live()) setFailed(true);
      }
    },
    [adapter, account],
  );
  useLive((live) => void load(live), [load, ledger], info !== null);

  const kindOf = useCallback((l: Listing): Kind => (l.collection === "rats" ? "rat" : boxes.get(l.tokenId)?.status === "revealed" ? "cat" : "box"), [boxes]);

  const shown = useMemo(() => {
    if (!listings) return [];
    const list = listings.filter((l) => {
      if (filter === "mine") return !!account && sameAddress(l.seller, account) && (l.status === "active" || l.status === "pending");
      if (l.status !== "active") return false;
      return filter === "all" || kindOf(l) === filter;
    });
    if (sort === "cheap") list.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    if (sort === "dear") list.sort((a, b) => (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));
    return list;
  }, [listings, filter, sort, account, kindOf]);

  const active = listings?.filter((l) => l.status === "active") ?? [];
  const sold = listings?.filter((l) => l.status === "sold") ?? [];
  const openOffers = myOffers.filter((o) => o.status === "open");
  const booth = open === null ? null : (listings?.find((l) => l.listingId === open) ?? null);

  const celebrate = (text: string) => setParty({ key: Date.now(), text });

  const artOf = (l: Listing) => (l.collection === "rats" ? ratArt(rats.get(l.tokenId)) : boxArt(l.tokenId, boxes.get(l.tokenId)));
  const nameOf = (l: Listing) => (l.collection === "rats" ? t("fm.ratName", { id: l.tokenId }) : buildBoxSpec(l.tokenId).serial);

  return (
    <div className="fm">
      <div className="fm-lights" aria-hidden="true">
        {Array.from({ length: 18 }, (_, i) => (
          <span key={i} style={{ animationDelay: `${(i * 0.37) % 2.4}s` }} />
        ))}
      </div>

      <header className="fm-head">
        <h2 className="fm-sign">
          <span className="fm-sign-small">{t("fm.signSmall")}</span>
          <span className="fm-sign-big">{t("fm.title")}</span>
        </h2>
        <p className="fm-tagline">{t("fm.tagline")}</p>
      </header>

      <div className="fm-ctas">
        <button type="button" className="fm-cta fm-cta-box" onClick={onShop}>
          <span className="fm-cta-icon" aria-hidden="true">
            <BoxIcon />
          </span>
          <span className="fm-cta-text">
            <strong>{t("fm.cta.mintBox")}</strong>
            <small>{t("fm.cta.mintBoxHint")}</small>
          </span>
        </button>
        <a className="fm-cta fm-cta-rat" href={studioPath(locale)}>
          <span className="fm-cta-icon" aria-hidden="true">
            <RatIcon />
          </span>
          <span className="fm-cta-text">
            <strong>{t("fm.cta.mintRat")}</strong>
            <small>{t("fm.cta.mintRatHint")}</small>
          </span>
        </a>
        <button type="button" className="fm-cta fm-cta-sell" onClick={() => (account ? setSelling(true) : void connect())} disabled={!info}>
          <span className="fm-cta-icon" aria-hidden="true">
            <TagIcon />
          </span>
          <span className="fm-cta-text">
            <strong>{t("fm.cta.sell")}</strong>
            <small>{account ? t("fm.cta.sellHint") : t("fm.connectFirst")}</small>
          </span>
        </button>
      </div>

      {info === null ? (
        <div className="fm-closed">
          <p className="fm-closed-sign">{t("fm.closed")}</p>
          <p className="fine">{t("fm.closedHint")}</p>
        </div>
      ) : (
        <>
          <div className="fm-bar">
            <div className="fm-signs" role="group" aria-label={t("fm.filter.label")}>
              {FILTERS.map((f, i) => (
                <button
                  key={f.key}
                  type="button"
                  className="fm-signpost"
                  style={{ transform: `rotate(${[-3, 2, -1.5, 2.5, -2][i]}deg)` }}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {t(f.label)}
                  {f.key === "mine" && received.length > 0 && <span className="fm-badge">{received.length}</span>}
                </button>
              ))}
            </div>
            <label className="fm-sort">
              <span>{t("fm.sort.label")}</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="new">{t("fm.sort.new")}</option>
                <option value="cheap">{t("fm.sort.cheap")}</option>
                <option value="dear">{t("fm.sort.dear")}</option>
              </select>
            </label>
          </div>

          <p className="fm-stats">
            {t("fm.stats", { active: active.length, sold: sold.length, fee: info ? info.feeBps / 100 : "…" })}
            {openOffers.length > 0 && (
              <>
                {" · "}
                <button type="button" className="link" onClick={() => setOpen(openOffers[0]!.listingId)}>
                  {t("fm.myOffers", { n: openOffers.length })}
                </button>
              </>
            )}
          </p>

          {failed && <p className="fm-note">{t("fm.failed")}</p>}

          {listings === null ? (
            <p className="fm-note">{t("fm.reading")}</p>
          ) : shown.length === 0 ? (
            <div className="fm-empty">
              <span className="fm-tumbleweed" aria-hidden="true" />
              <p>{filter === "mine" ? t("fm.emptyMine") : t("fm.empty")}</p>
            </div>
          ) : (
            <ul className="fm-grid">
              {shown.map((l, i) => {
                const kind = kindOf(l);
                const mine = !!account && sameAddress(l.seller, account);
                const box = boxes.get(l.tokenId);
                const cat = kind === "cat" && box?.revealed ? catFromRevealed(box.revealed) : null;
                const offersHere = received.filter((o) => o.listingId === l.listingId).length;
                const art = artOf(l);
                return (
                  <li key={l.listingId} className={`fm-item fm-item-${kind}`} style={{ animationDelay: `${Math.min(i, 12) * 60}ms` }}>
                    <button type="button" className="fm-stall" onClick={() => setOpen(l.listingId)} aria-label={t("fm.openBooth", { name: nameOf(l) })}>
                      <span className="fm-awning" aria-hidden="true" />
                      <span className="fm-art">
                        {art ? <img src={art} alt="" loading="lazy" /> : <span className="fm-art-blank" />}
                        {kind === "box" && <span className="fm-mystery" aria-hidden="true">?</span>}
                      </span>
                      <span className="fm-tag">
                        <span className="fm-tag-hole" aria-hidden="true" />
                        <span className="fm-tag-price">{money(l.price)}</span>
                        <span className="fm-tag-unit">cUSDC</span>
                      </span>
                      <span className="fm-name">{nameOf(l)}</span>
                      <span className="fm-kind">
                        {t(KIND_LABEL[kind])}
                        {cat && ` · ${catNames(cat).tier}`}
                        {kind === "box" && box?.aliveCheck === "alive" && ` · ${t("fm.vet")}`}
                      </span>
                      {mine && <span className="fm-ribbon">{l.status === "pending" ? t("fm.pending") : t("fm.yours")}</span>}
                      {mine && offersHere > 0 && <span className="fm-envelope-badge">{t("fm.offersBadge", { n: offersHere })}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {sold.length > 0 && (
            <div className="fm-ticker" aria-label={t("fm.ticker")}>
              <div className="fm-ticker-track">
                {[...sold.slice(0, 12), ...sold.slice(0, 12)].map((l, i) => (
                  <span key={i} className="fm-ticker-item">
                    <b>{t("fm.soldStamp")}</b> {nameOf(l)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {booth && (
        <Booth
          listing={booth}
          kind={kindOf(booth)}
          box={boxes.get(booth.tokenId)}
          rat={rats.get(booth.tokenId)}
          art={artOf(booth)}
          name={nameOf(booth)}
          info={info ?? null}
          myOffers={myOffers.filter((o) => o.listingId === booth.listingId)}
          onClose={() => setOpen(null)}
          onInspect={onInspect}
          onDone={(text) => {
            celebrate(text);
            bumpLedger();
          }}
        />
      )}
      {selling && info && (
        <SellDrawer
          info={info}
          onClose={() => setSelling(false)}
          onListed={(name) => {
            setSelling(false);
            setFilter("mine");
            celebrate(t("fm.listedParty", { name }));
          }}
        />
      )}
      {party && <Confetti key={party.key} text={party.text} onDone={() => setParty(null)} />}
    </div>
  );
}

interface BoothProps {
  listing: Listing;
  kind: Kind;
  box: BoxInfo | undefined;
  rat: RatInfo | undefined;
  art: string | null;
  name: string;
  info: FleaMarketInfo | null;
  myOffers: MarketOffer[];
  onClose: () => void;
  onInspect: (tokenId: number) => void;
  onDone: (text: string) => void;
}

/** One item up close: what is known about it, and the ways to buy it, or to sell it if it is yours. */
function Booth({ listing, kind, box, rat, art, name, info, myOffers, onClose, onInspect, onDone }: BoothProps) {
  const t = useT();
  const { adapter, account, connect } = useChain();
  const action = useAction();
  const pay = usePayment();
  const ledger = useLedger();
  const mine = !!account && sameAddress(listing.seller, account);
  const forSale = listing.status === "active";
  const [offerText, setOfferText] = useState("");
  const [priceText, setPriceText] = useState(formatAmount(listing.price, DECIMALS));
  const [sealed, setSealed] = useState(false);
  const [offers, setOffers] = useState<MarketOffer[]>([]);
  const [amounts, setAmounts] = useState<Record<number, bigint>>({});
  const [sniffed, setSniffed] = useState<TraitRoll | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !action.busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, action.busy]);

  // The seller sees every open offer; a buyer sees their own.
  useEffect(() => {
    let live = true;
    if (!mine) return;
    adapter.offers({ listingId: listing.listingId, status: "open" }).then(
      (o) => live && setOffers(o),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [adapter, listing.listingId, mine, ledger]);

  const fee = info ? (listing.price * BigInt(info.feeBps)) / 10_000n : 0n;
  const offerAmount = parseAmount(offerText, DECIMALS);
  const newPrice = parseAmount(priceText, DECIMALS);
  const cat = kind === "cat" && box?.revealed ? catFromRevealed(box.revealed) : null;
  const myOpen = myOffers.filter((o) => o.status === "open");

  const buy = async () => {
    const done = await action.run("fm-buy", async (o) => {
      await adapter.buyListing(listing.listingId, { ...o, pay });
      return true;
    });
    if (done) onDone(t("fm.boughtParty", { name }));
  };

  const offer = async () => {
    if (!offerAmount) return;
    const id = await action.run("fm-offer", (o) => adapter.makeOffer(listing.listingId, offerAmount, { ...o, pay }));
    if (id === undefined) return;
    setSealed(true);
    setOfferText("");
    // In the demo the night shift may take a fair offer at once: then the item is already yours.
    const after = await adapter.listings({ seller: listing.seller }).catch(() => []);
    if (after.find((l) => l.listingId === listing.listingId)?.status === "sold") onDone(t("fm.acceptedParty", { name }));
    else bumpLedger();
  };

  const reveal = async () => {
    const got = await action.run("fm-reveal", (o) => adapter.offerAmounts(offers.map((x) => x.offerId), o));
    if (got) setAmounts(got);
  };

  const accept = async (offerId: number) => {
    const done = await action.run("fm-accept", async (o) => {
      await adapter.acceptOffer(offerId, o);
      return true;
    });
    if (done) onDone(t("fm.soldParty", { name }));
  };

  const withdraw = (offerId: number) => void action.run("fm-withdraw", (o) => adapter.withdrawOffer(offerId, o));
  const cancel = async () => {
    const done = await action.run("fm-cancel", async (o) => {
      await adapter.cancelListing(listing.listingId, o);
      return true;
    });
    if (done) onClose();
  };
  const reprice = () => newPrice && void action.run("fm-reprice", (o) => adapter.repriceListing(listing.listingId, newPrice, o));
  const sniff = async () => {
    const roll = await action.run("fm-sniff", (o) => adapter.paidShake(listing.tokenId, { ...o, pay }));
    if (roll) setSniffed(roll);
  };

  const busyTitle: Record<string, AppKey> = {
    "fm-buy": "fm.busy.buy",
    "fm-offer": "fm.busy.offer",
    "fm-reveal": "fm.busy.reveal",
    "fm-accept": "fm.busy.accept",
    "fm-withdraw": "fm.busy.withdraw",
    "fm-cancel": "fm.busy.cancel",
    "fm-reprice": "fm.busy.reprice",
    "fm-sniff": "fm.busy.sniff",
  };

  return (
    <div className="fm-veil" onClick={(e) => e.target === e.currentTarget && !action.busy && onClose()}>
      <section className={`fm-booth fm-booth-${kind}`} role="dialog" aria-modal="true" aria-label={name}>
        <button type="button" className="fm-close" onClick={onClose} disabled={!!action.busy} aria-label={t("fm.close")}>
          ×
        </button>
        <div className="fm-booth-art">
          <span className="fm-spot" aria-hidden="true" />
          {art && <img src={art} alt="" />}
          {kind === "box" && (
            <span className="fm-qmarks" aria-hidden="true">
              <i>?</i>
              <i>?</i>
              <i>?</i>
            </span>
          )}
          {listing.status === "sold" && <span className="fm-sold-stamp">{t("fm.soldStamp")}</span>}
        </div>

        <div className="fm-booth-body">
          <p className="fm-booth-kind">{t(KIND_LABEL[kind])}</p>
          <h3 className="fm-booth-name">{name}</h3>

          <dl className="fields">
            <div>
              <dt>{t("fm.price")}</dt>
              <dd className="fm-booth-price">
                {money(listing.price)} <small>cUSDC</small>
              </dd>
            </div>
            <div>
              <dt>{t("fm.seller")}</dt>
              <dd>{mine ? t("holder.you") : shortAddress(listing.seller)}</dd>
            </div>
            {kind === "box" && box && (
              <div>
                <dt>{t("fm.inside")}</dt>
                <dd>
                  {t("fm.insideSealed")}
                  {box.partner !== null && t("box.entangledWith", { serial: buildBoxSpec(box.partner).serial })}
                  {box.aliveCheck === "alive" && ` ${t("fm.vet")}.`}
                </dd>
              </div>
            )}
            {cat && box?.revealed && (
              <div>
                <dt>{t("fm.cat")}</dt>
                <dd>{t("fm.catLine", { tier: catNames(cat).tier, state: cap(catNames(cat).state), breed: catNames(cat).breed, score: box.revealed.score })}</dd>
              </div>
            )}
            {kind === "rat" && rat && (
              <div>
                <dt>{t("fm.rat")}</dt>
                <dd>{rat.kind === "seed" ? t("fm.ratSeed") : t("fm.ratAi")}</dd>
              </div>
            )}
          </dl>

          {listing.collection === "boxes" && (
            <p className="fine">
              <button type="button" className="link" onClick={() => onInspect(listing.tokenId)}>
                {t("fm.inspect")}
              </button>
            </p>
          )}

          <TxPending busy={action.busy} step={action.step} title={action.busy ? t(busyTitle[action.busy] ?? "tx.working") : ""} secret={action.busy === "fm-reveal"}>
            {!account ? (
              <button type="button" className="stamp-button" onClick={() => void connect()}>
                {t("fm.connectFirst")}
              </button>
            ) : !forSale ? (
              <p className="state-note">{listing.status === "pending" ? t("fm.pendingHint") : t("fm.gone")}</p>
            ) : mine ? (
              <>
                <div className="fm-offers">
                  <p className="slip-heading">{t("fm.offersHeading", { n: offers.length })}</p>
                  {offers.length === 0 ? (
                    <p className="fine">{t("fm.noOffers")}</p>
                  ) : (
                    <>
                      <ul className="fm-envelopes">
                        {offers.map((o) => {
                          const amount = amounts[o.offerId];
                          const opened = amount !== undefined;
                          return (
                            <li key={o.offerId} className={`fm-envelope${opened ? " is-open" : ""}`}>
                              <span className="fm-envelope-flap" aria-hidden="true" />
                              <span className="fm-envelope-seal" aria-hidden="true" />
                              <span className="fm-envelope-from">{shortAddress(o.buyer)}</span>
                              <span className="fm-envelope-amount">{opened ? `${money(amount)} cUSDC` : t("fm.sealedAmount")}</span>
                              {opened && (
                                <button type="button" className="plain-button" onClick={() => void accept(o.offerId)} disabled={amount === 0n}>
                                  {amount === 0n ? t("fm.emptyOffer") : t("fm.accept")}
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      {Object.keys(amounts).length < offers.length && (
                        <button type="button" className="plain-button" onClick={() => void reveal()}>
                          {t("fm.revealOffers")}
                        </button>
                      )}
                      <p className="fine">{t("fm.offersPrivate")}</p>
                    </>
                  )}
                </div>
                <form
                  className="fm-reprice"
                  onSubmit={(e) => {
                    e.preventDefault();
                    reprice();
                  }}
                >
                  <label>
                    <span>{t("fm.reprice")}</span>
                    <input inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
                  </label>
                  <button type="submit" className="plain-button" disabled={!newPrice || newPrice === listing.price}>
                    {t("fm.repriceGo")}
                  </button>
                </form>
                <p className="fine">
                  <button type="button" className="link" onClick={() => void cancel()}>
                    {t("fm.takeBack")}
                  </button>{" "}
                  {t("fm.takeBackHint")}
                </p>
              </>
            ) : (
              <>
                <button type="button" className="stamp-button fm-buy" onClick={() => void buy()}>
                  {t("fm.buy", { price: money(listing.price) })}
                </button>
                <PayLine busy={action.busy} need={listing.price} />

                <form
                  className={`fm-offer${sealed ? " is-sealed" : ""}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void offer();
                  }}
                >
                  <p className="slip-heading">{t("fm.offerHeading")}</p>
                  <div className="fm-offer-row">
                    <input inputMode="decimal" placeholder={formatAmount((listing.price * 8n) / 10n, DECIMALS)} value={offerText} onChange={(e) => (setOfferText(e.target.value), setSealed(false))} aria-label={t("fm.offerAmount")} />
                    <button type="submit" className="plain-button" disabled={!offerAmount || (!!info && offerAmount > info.maxPrice)}>
                      {t("fm.offerGo")}
                    </button>
                  </div>
                  <p className="fine">{sealed ? t("fm.offerSealed") : t("fm.offerHint")}</p>
                  {sealed && <span className="fm-wax" aria-hidden="true" />}
                </form>

                {myOpen.length > 0 && (
                  <ul className="fm-mine">
                    {myOpen.map((o) => (
                      <li key={o.offerId}>
                        {t("fm.yourOffer", { id: o.offerId })}{" "}
                        <button type="button" className="link" onClick={() => withdraw(o.offerId)}>
                          {t("fm.withdraw")}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {kind === "box" && (
                  <p className="fine">
                    <button type="button" className="link" onClick={() => void sniff()}>
                      {t("fm.sniff")}
                    </button>{" "}
                    {sniffed ? t("fm.sniffed", traitCopy(sniffed)) : t("fm.sniffHint")}
                  </p>
                )}
              </>
            )}
            <p className="fine fm-feeline">{t("fm.feeLine", { fee: money(fee), bps: info ? info.feeBps / 100 : "…" })}</p>
            <div aria-live="polite">{action.error && <ProblemNote problem={action.error} />}</div>
          </TxPending>
          {/* Offers made earlier stay withdrawable once the item is gone. */}
          {!forSale && myOpen.length > 0 && (
            <ul className="fm-mine">
              {myOpen.map((o) => (
                <li key={o.offerId}>
                  {t("fm.yourOffer", { id: o.offerId })}{" "}
                  <button type="button" className="link" onClick={() => withdraw(o.offerId)} disabled={!!action.busy}>
                    {t("fm.withdraw")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

interface Sellable {
  collection: MarketCollection;
  tokenId: number;
  kind: Kind;
  name: string;
  art: string | null;
}

/** The player's own things, one tap from a price tag. */
function SellDrawer({ info, onClose, onListed }: { info: FleaMarketInfo; onClose: () => void; onListed: (name: string) => void }) {
  const t = useT();
  const { adapter, account, myBoxes, boxesKnown, findMyBoxes, findError } = useChain();
  const action = useAction();
  const [items, setItems] = useState<Sellable[] | null>(null);
  const [picked, setPicked] = useState<Sellable | null>(null);
  const [priceText, setPriceText] = useState("10");
  const price = parseAmount(priceText, DECIMALS);

  useEffect(() => {
    if (!account) return;
    let live = true;
    void (async () => {
      const [boxRows, ratRows] = await Promise.all([Promise.all(myBoxes.map((id) => adapter.box(id).catch(() => null))), adapter.ratsOf(account).catch(() => [])]);
      if (!live) return;
      setItems([
        ...boxRows.flatMap((b) => (b ? [{ collection: "boxes" as const, tokenId: b.tokenId, kind: (b.status === "revealed" ? "cat" : "box") as Kind, name: buildBoxSpec(b.tokenId).serial, art: boxArt(b.tokenId, b) }] : [])),
        ...ratRows.map((r) => ({ collection: "rats" as const, tokenId: r.id, kind: "rat" as Kind, name: t("fm.ratName", { id: r.id }), art: ratArt(r) })),
      ]);
    })();
    return () => {
      live = false;
    };
  }, [adapter, account, myBoxes, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !action.busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, action.busy]);

  const list = async () => {
    if (!picked || !price) return;
    const done = await action.run("fm-list", (o) => adapter.listItem(picked.collection, picked.tokenId, price, o));
    if (done) onListed(picked.name);
  };

  const fee = price ? (price * BigInt(info.feeBps)) / 10_000n : 0n;
  return (
    <div className="fm-veil" onClick={(e) => e.target === e.currentTarget && !action.busy && onClose()}>
      <section className="fm-drawer" role="dialog" aria-modal="true" aria-label={t("fm.sell.title")}>
        <button type="button" className="fm-close" onClick={onClose} disabled={!!action.busy} aria-label={t("fm.close")}>
          ×
        </button>
        <h3 className="fm-drawer-title">{t("fm.sell.title")}</h3>
        <TxPending busy={action.busy} step={action.step} title={t("fm.busy.list")}>
          {!boxesKnown && (
            <p className="fine">
              <button type="button" className="link" onClick={() => void findMyBoxes()}>
                {t("fm.sell.findBoxes")}
              </button>{" "}
              {t("fm.sell.findHint")}
              {findError && <span className="problem"> {findError}</span>}
            </p>
          )}
          {items === null ? (
            <p className="fine">{t("fm.reading")}</p>
          ) : items.length === 0 ? (
            <p className="state-note">{t("fm.sell.nothing")}</p>
          ) : (
            <ul className="fm-pick">
              {items.map((it) => (
                <li key={`${it.collection}:${it.tokenId}`}>
                  <button type="button" aria-pressed={picked?.collection === it.collection && picked.tokenId === it.tokenId} onClick={() => setPicked(it)}>
                    {it.art ? <img src={it.art} alt="" /> : <span className="fm-art-blank" />}
                    <span>{it.name}</span>
                    <small>{t(KIND_LABEL[it.kind])}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {picked && (
            <form
              className="fm-price-form"
              onSubmit={(e) => {
                e.preventDefault();
                void list();
              }}
            >
              <label>
                <span>{t("fm.sell.price")}</span>
                <span className="fm-price-input">
                  <input inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} autoFocus />
                  <small>cUSDC</small>
                </span>
              </label>
              <div className="fm-chips">
                {QUICK_PRICES.map((p) => (
                  <button key={p} type="button" className="fm-chip" aria-pressed={priceText === p} onClick={() => setPriceText(p)}>
                    {p}
                  </button>
                ))}
              </div>
              <p className="fine">{t("fm.sell.youGet", { net: price ? money(price - fee) : "…", bps: info.feeBps / 100 })}</p>
              {picked.collection === "boxes" && <p className="fine fm-leak">{t("fm.sell.leak")}</p>}
              <button type="submit" className="stamp-button" disabled={!price || price > info.maxPrice}>
                {t("fm.sell.go", { name: picked.name })}
              </button>
            </form>
          )}
          <div aria-live="polite">{action.error && <ProblemNote problem={action.error} />}</div>
        </TxPending>
      </section>
    </div>
  );
}

function BoxIcon() {
  return (
    <svg viewBox="0 0 48 48">
      <path d="M6 16 24 8l18 8v18l-18 8-18-8z" fill="#B8895A" stroke="#1c1814" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M6 16l18 8 18-8M24 24v18" fill="none" stroke="#1c1814" strokeWidth="2.5" />
      <path d="M15 12l18 8v6" fill="none" stroke="#D9C28A" strokeWidth="4" />
    </svg>
  );
}

function RatIcon() {
  return (
    <svg viewBox="0 0 48 48">
      <path className="fm-rat-tail" d="M10 32c-6 0-7 7-1 9" fill="none" stroke="#c99a8a" strokeWidth="2.5" strokeLinecap="round" />
      <ellipse cx="24" cy="30" rx="13" ry="9" fill="#8d8a86" stroke="#1c1814" strokeWidth="2.5" />
      <circle cx="35" cy="23" r="6" fill="#8d8a86" stroke="#1c1814" strokeWidth="2.5" />
      <circle cx="33" cy="17" r="3.5" fill="#e8b3a8" stroke="#1c1814" strokeWidth="2" />
      <circle cx="37" cy="22" r="1.3" fill="#1c1814" />
      <circle cx="41" cy="25" r="1.4" fill="#e8798a" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 48 48">
      <path d="M8 22V8h14l18 18-14 14z" fill="#FFB454" stroke="#1c1814" strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx="15" cy="15" r="3" fill="#1c1814" />
      <path d="M20 28l8-8M24 32l8-8" stroke="#C2261D" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
