import { useEffect, useMemo, useState } from "react";
import { sameAddress, type BoxInfo, type DuelInfo, type PendingRequest } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { catFromRevealed, fee, saleCopy } from "../chain/copy";
import { usePayment } from "../chain/payment";
import { useT } from "../i18n/app";
import { SHELF_CAPACITY, ShelfScene, type ShelfBox } from "../scenes/Scenes";
import { FindMine } from "./FindMine";
import type { PairIntent } from "./PairView";
import { PayWith } from "./PayWith";
import { Stage } from "./Stage";
import { useFold } from "./useFold";
import { ProblemNote } from "./ProblemNote";
import { TxPending } from "./TxPending";
import { boxTags } from "../chain/tags";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
  /** Takes a box to the pair view to propose a duel or an entanglement with it. */
  onPair: (tokenId: number, intent: PairIntent) => void;
  /** Opens the pair view on two boxes, to answer or finish the duel between them. */
  onOpenPair: (tokenA: number, tokenB: number) => void;
  /** Opens the duel shelf, offering to put `tokenId` up when given. */
  onDuels: (tokenId?: number | null) => void;
}

/** How many of the account's boxes are read and listed. The newest come first. */
const LIST_LIMIT = 40;

export function ShelfView({ quality, sound, onSelect, onPair, onOpenPair, onDuels }: Props) {
  const { adapter, account, collection, myBoxes, boxesKnown, findMyBoxes, refresh, connect, mode } = useChain();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const action = useAction();
  const [quantity, setQuantity] = useState(1);
  const maxPerTx = collection?.maxPerTx ?? 1;
  // How many box numbers to hide the quantity among. Everyone sees them; only you know which are yours.
  const [ids, setIds] = useState<number | null>(null);
  const among = Math.max(quantity, ids ?? maxPerTx);
  const [infos, setInfos] = useState<BoxInfo[]>([]);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [duels, setDuels] = useState<DuelInfo[]>([]);
  const [earned, setEarned] = useState<bigint | null>(null);
  const pay = usePayment();
  const [arrived, setArrived] = useState<number[]>([]);
  // The box whose tag is pointed at in the slip: it lifts on the bench.
  const [pointed, setPointed] = useState<number | null>(null);
  // On a phone only one slip shows at a time: the boxes, or the order.
  const [tab, setTab] = useState<"boxes" | "order">("boxes");
  // The slip whose action is running or last failed: its step and its error show there.
  const [ran, setRan] = useState<"boxes" | "order">("order");
  const here = (slip: "boxes" | "order") => ran === slip;

  const listed = useMemo(() => [...myBoxes].reverse().slice(0, LIST_LIMIT), [myBoxes]);

  useEffect(() => {
    let live = true;
    void Promise.all(listed.map((id) => adapter.box(id)))
      .then((boxes) => live && setInfos(boxes))
      .catch(() => live && setInfos([]));
    if (account) void adapter.pendingRequests(account).then((p) => live && setPending(p)).catch(() => undefined);
    else setPending([]);
    return () => {
      live = false;
    };
  }, [adapter, account, listed]);

  // Open duels the account put up or took up, and those reserved for its boxes once it found
  // them: kept by the API, so they follow the account from one device to another.
  useEffect(() => {
    let live = true;
    if (!account) setDuels([]);
    else
      void adapter
        .duels({ account, tokenIds: boxesKnown ? myBoxes : undefined, open: true })
        .then((list) => live && setDuels(list))
        .catch(() => live && setDuels([]));
    return () => {
      live = false;
    };
  }, [adapter, account, boxesKnown, myBoxes]);

  const duelState = (d: DuelInfo) =>
    d.status === "pending"
      ? t("shelf.duelToFinish")
      : d.status === "posted"
        ? t("shelf.duelToProve")
        : sameAddress(d.challenger, account)
          ? t("shelf.duelOnShelf")
          : t("shelf.duelYourMove");
  /** A duel between two known boxes opens in the pair view; one still waiting for a taker, on the duel shelf. */
  const openDuel = (d: DuelInfo) => (d.tokenB === null ? onDuels() : onOpenPair(d.tokenA, d.tokenB));

  const onBench: ShelfBox[] = useMemo(
    () => infos.slice(0, SHELF_CAPACITY).map((b) => ({
        tokenId: b.tokenId,
        cat: b.revealed ? catFromRevealed(b.revealed) : null,
        vet: b.aliveCheck === "alive" || b.aliveCheck === "notAlive" ? b.aliveCheck : null,
        tags: boxTags(b, duels),
      })),
    // `t` changes with the language the tags are worded in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [infos, duels, t],
  );

  const mint = async () => {
    sound.resume();
    setRan("order");
    const got = await action.run("mint", (o) => adapter.mint(quantity, { ...o, pay, ids: among }), { landed: "problem.landedMint" });
    if (!got) return;
    setArrived(got);
    // Boxes never looked up yet: the shelf would stay on "Show my boxes" and hide the new ones.
    // The mint just decrypted its receipts, so the lookup reuses that permit: no new signature.
    if (boxesKnown) await refresh();
    else await findMyBoxes();
  };

  /** A request whose proof never made it, say because the tab was closed. */
  const finish = async (request: PendingRequest) => {
    setRan("boxes");
    const done = await action.run("finish", async (o) => {
      await adapter.finishRequest(request.requestId, o);
      return true;
    });
    if (account) void adapter.pendingRequests(account).then(setPending).catch(() => undefined);
    if (done) await refresh();
  };

  /** What strangers paid to shake these boxes, partly left inside for their holder. */
  const collect = async () => {
    setRan("boxes");
    const got = await action.run("collect", (o) => adapter.claimEarnings(myBoxes.slice(-10), o));
    if (got !== undefined) setEarned(got);
  };

  const soldOut = !!collection?.sale.soldOut;
  const total = collection ? collection.fees.mint * BigInt(quantity) : 0n;
  const sealedMine = infos.some((b) => b.status === "sealed");

  // Shown on a phone only, in place of each slip's title.
  const tabs = (
    <div className="slip-tabs" role="tablist" aria-label={t("shelf.title")}>
      <button type="button" role="tab" aria-selected={tab === "boxes"} onClick={() => setTab("boxes")}>
        {t("shelf.boxes")}
        {boxesKnown && myBoxes.length > 0 && <span>{myBoxes.length}</span>}
      </button>
      <button type="button" role="tab" aria-selected={tab === "order"} data-tour="mint" onClick={() => setTab("order")}>
        {t("shelf.order")}
      </button>
    </div>
  );

  return (
    <>
      <Stage quality={quality}>
        <ShelfScene boxes={onBench} arrivals={arrived} quality={quality} sound={sound} highlight={pointed} onSelect={onSelect} />
      </Stage>

      {/* Hung above the empty shelf, where the boxes will land once they are found. A phone has no
          room above the slip: there the button goes in the slip instead (see .find-in-slip). */}
      {account && !boxesKnown && (
        <div className="find-over">
          <FindMine />
        </div>
      )}

      {!account ? (
        <section className={`slip${foldClass}`} aria-label={t("shelf.title")}>
          {foldButton}
          <div className="slip-head">
            <span>{t("shelf.title")}</span>
            {collection && <span>{saleCopy(collection)}</span>}
          </div>
          <p className="state-note">{t("shelf.noWallet")}</p>
          <p className="fine after-table">{t("shelf.connectHint")}</p>
          <button type="button" className="stamp-button" onClick={() => void connect()}>
            {t("nav.connect")}
          </button>
        </section>
      ) : (
        <>
          {/* Two slips on a desktop: the boxes on the left, the order on the right, each short enough
              to read without scrolling. A phone has room for one: the tabs switch between them. */}
          <section className={`slip shelf-slip${foldClass}${tab === "boxes" ? "" : " is-away"}`} data-tour="boxes" aria-label={t("shelf.boxes")}>
            {foldButton}
            <div className="slip-head">
              {tabs}
              <span className="slip-title">{t("shelf.boxes")}</span>
              {boxesKnown && <span>{myBoxes.length}</span>}
            </div>

            <TxPending busy={here("boxes") ? action.busy : null} step={action.step} title={t("tx.working")} secret={action.busy === "collect"}>
              {!boxesKnown ? (
                <>
                  <p className="state-note find-note">{t("mine.findAbove")}</p>
                  <div className="find-in-slip">
                    <FindMine />
                  </div>
                </>
              ) : myBoxes.length === 0 ? (
                <p className="state-note">{t("shelf.empty")}</p>
              ) : (
                <ul className="tags" aria-label={t("shelf.boxes")}>
                  {(infos.length ? infos : listed.map((tokenId) => ({ tokenId, status: null, partner: null }))).map((b) => (
                    <li key={b.tokenId} onPointerEnter={() => setPointed(b.tokenId)} onPointerLeave={() => setPointed(null)} onFocus={() => setPointed(b.tokenId)} onBlur={() => setPointed(null)}>
                      <button type="button" onClick={() => onSelect(b.tokenId)} className={b.status === "revealed" ? "is-open" : ""}>
                        {buildBoxSpec(b.tokenId).serial}
                        <span>
                          {b.status === null ? "…" : b.status === "revealed" ? t("status.open") : b.status === "opening" ? t("status.opening") : t("status.sealed")}
                          {b.partner !== null ? `, ${t("shelf.linked")}` : ""}
                        </span>
                      </button>
                      {/* Both are opt-in, and only while the box is sealed: the contract refuses them after. */}
                      {b.status === "sealed" && (
                        <span className="tag-options" role="group" aria-label={t("shelf.boxActions", { serial: buildBoxSpec(b.tokenId).serial })}>
                          <button type="button" onClick={() => onDuels(b.tokenId)} disabled={!!action.busy}>
                            {t("shelf.duel")}
                          </button>
                          {b.partner === null && (
                            <button type="button" onClick={() => onPair(b.tokenId, "entangle")} disabled={!!action.busy}>
                              {t("shelf.entangle")}
                            </button>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {myBoxes.length > LIST_LIMIT && <p className="fine">{t("shelf.showing", { limit: LIST_LIMIT, total: myBoxes.length })}</p>}
              {boxesKnown && myBoxes.length > 0 && <p className="fine">{t("shelf.private")}</p>}

              {duels.length > 0 && (
                <>
                  <ul className="tags" aria-label={t("shelf.duels")}>
                    {duels.map((d) => (
                      <li key={d.duelId}>
                        <button type="button" onClick={() => openDuel(d)}>
                          {d.tokenB === null
                            ? t("shelf.duelUp", { a: buildBoxSpec(d.tokenA).serial })
                            : t("shelf.duelVs", { a: buildBoxSpec(d.tokenA).serial, b: buildBoxSpec(d.tokenB).serial })}
                          <span>{duelState(d)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="fine">{t("shelf.duelsHint")}</p>
                </>
              )}


              <div className="felt" aria-live="polite">
                {here("boxes") && action.error ? (
                  <ProblemNote problem={action.error} />
                ) : earned !== null ? (
                  <p className="fine">{earned > 0n ? t("shelf.earned", { fee: fee(earned, collection) }) : t("shelf.earnedNothing")}</p>
                ) : null}
                {pending.length > 0 && !action.busy && (
                  <p className="fine">
                    {t("shelf.pendingRequest", { count: pending.length })}{" "}
                    <button type="button" className="link" onClick={() => void finish(pending[0]!)}>
                      {t("shelf.finishRequest")}
                    </button>
                  </p>
                )}
                {boxesKnown && sealedMine && !action.busy && (
                  <p className="fine">
                    {t("shelf.earnings")}{" "}
                    <button type="button" className="link" onClick={() => void collect()}>
                      {t("shelf.collectEarnings")}
                    </button>
                  </p>
                )}
              </div>
            </TxPending>
          </section>

          <section className={`slip shelf-slip shelf-order${foldClass}${tab === "order" ? "" : " is-away"}`} data-tour="mint" aria-label={t("shelf.order")}>
            {foldButton}
            <div className="slip-head">
              {tabs}
              <span className="slip-title">{t("shelf.order")}</span>
              {collection && <span>{saleCopy(collection)}</span>}
            </div>

            <TxPending busy={here("order") ? action.busy : null} step={action.step} title={action.busy === "mint" ? t("shelf.ordering") : t("tx.working")} secret>
              <div className="order">
                <div className="stepper" role="group" aria-label={t("shelf.howMany")}>
                  <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={!!action.busy || quantity <= 1} aria-label={t("shelf.fewer")}>
                    −
                  </button>
                  <output aria-live="polite">{quantity}</output>
                  <button type="button" onClick={() => setQuantity((q) => Math.min(maxPerTx, q + 1))} disabled={!!action.busy || quantity >= maxPerTx} aria-label={t("shelf.more")}>
                    +
                  </button>
                </div>
                <button type="button" className="stamp-button" onClick={() => void mint()} disabled={!!action.busy || !collection || soldOut}>
                  {action.busy === "mint" ? t("shelf.ordering") : soldOut ? t("shelf.soldOut") : t("shelf.mint", { count: quantity })}
                </button>
              </div>

              {/* The cart: every carton that leaves looks the same. The buyer's are always loaded; a
                  tap on a later spot loads empty ones up to it, a tap on the last loaded one unloads it. */}
              <div className="cart" role="group" aria-label={t("shelf.cart")}>
                <span className="cart-title">{t("shelf.cart")}</span>
                <div className="cart-bed" style={{ gridTemplateColumns: `repeat(${maxPerTx}, 1fr)` }}>
                  {Array.from({ length: maxPerTx }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={n <= among ? "carton" : "carton is-free"}
                      onClick={() => setIds(n === among && n > quantity ? n - 1 : Math.max(quantity, n))}
                      disabled={!!action.busy || n <= quantity}
                      aria-pressed={n <= among}
                      aria-label={t("shelf.ids", { count: Math.max(quantity, n) })}
                    />
                  ))}
                </div>
              </div>
              <p className="fine">
                {among === quantity
                  ? t("shelf.hideNone", { count: quantity })
                  : t("shelf.hideHint", { ids: among, count: quantity, empty: among - quantity })}
              </p>

              <PayWith busy={action.busy} need={total} />
              {pay === "usdc" && <p className="fine problem">{t("shelf.usdcShows")}</p>}

              <div className="felt" aria-live="polite">
                {here("order") && action.error ? (
                  <ProblemNote problem={action.error} />
                ) : arrived.length ? (
                  <p className="fine">{t("shelf.arrived", { serials: arrived.map((id) => buildBoxSpec(id).serial).join(", ") })}</p>
                ) : (
                  <p className="fine">
                    {t("shelf.price", { count: quantity, fee: fee(total, collection, pay) })}
                    {mode === "mock" ? t("shelf.mockFree") : ""}
                  </p>
                )}
              </div>
            </TxPending>
          </section>
        </>
      )}
    </>
  );
}
