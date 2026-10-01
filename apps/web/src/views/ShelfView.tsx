import { useEffect, useMemo, useState } from "react";
import type { BoxInfo, PendingRequest } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { catFromRevealed, fee, saleCopy, stepCopy } from "../chain/copy";
import { usePayment } from "../chain/payment";
import { useT } from "../i18n/app";
import { SHELF_CAPACITY, ShelfScene, type ShelfBox } from "../scenes/Scenes";
import { FindMine } from "./FindMine";
import type { PairIntent } from "./PairView";
import { PayWith } from "./PayWith";
import { Stage } from "./Stage";
import { useFold } from "./useFold";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
  /** Takes a box to the pair view to propose a duel or an entanglement with it. */
  onPair: (tokenId: number, intent: PairIntent) => void;
}

/** How many of the account's boxes are read and listed. The newest come first. */
const LIST_LIMIT = 40;

export function ShelfView({ quality, sound, onSelect, onPair }: Props) {
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
  const [earned, setEarned] = useState<bigint | null>(null);
  const pay = usePayment();
  const [arrived, setArrived] = useState<number[]>([]);
  // The box whose tag is pointed at in the slip: it lifts on the bench.
  const [pointed, setPointed] = useState<number | null>(null);

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

  const onBench: ShelfBox[] = useMemo(
    () => infos.slice(0, SHELF_CAPACITY).map((b) => ({
        tokenId: b.tokenId,
        cat: b.revealed ? catFromRevealed(b.revealed) : null,
        vet: b.aliveCheck === "alive" || b.aliveCheck === "notAlive" ? b.aliveCheck : null,
      })),
    [infos],
  );

  const mint = async () => {
    sound.resume();
    const got = await action.run("mint", (o) => adapter.mint(quantity, { ...o, pay, ids: among }));
    if (!got) return;
    setArrived(got);
    // Boxes never looked up yet: the shelf would stay on "Show my boxes" and hide the new ones.
    // The mint just decrypted its receipts, so the lookup reuses that permit: no new signature.
    if (boxesKnown) await refresh();
    else await findMyBoxes();
  };

  /** A request whose proof never made it, say because the tab was closed. */
  const finish = async (request: PendingRequest) => {
    const done = await action.run("finish", async (o) => {
      await adapter.finishRequest(request.requestId, o);
      return true;
    });
    if (account) void adapter.pendingRequests(account).then(setPending).catch(() => undefined);
    if (done) await refresh();
  };

  /** What strangers paid to shake these boxes, partly left inside for their holder. */
  const collect = async () => {
    const got = await action.run("collect", (o) => adapter.claimEarnings(myBoxes.slice(-10), o));
    if (got !== undefined) setEarned(got);
  };

  const soldOut = !!collection?.sale.soldOut;
  const total = collection ? collection.fees.mint * BigInt(quantity) : 0n;
  const sealedMine = infos.some((b) => b.status === "sealed");

  return (
    <>
      <Stage quality={quality}>
        <ShelfScene boxes={onBench} arrivals={arrived} quality={quality} sound={sound} highlight={pointed} onSelect={onSelect} />
      </Stage>

      {/* Hung above the empty shelf, where the boxes will land once they are found. */}
      {account && !boxesKnown && (
        <div className="find-over">
          <FindMine />
        </div>
      )}

      <section className={`slip${foldClass}`} aria-label={t("shelf.title")}>
        {foldButton}
        <div className="slip-head">
          <span>{t("shelf.title")}</span>
          {collection && <span>{saleCopy(collection)}</span>}
        </div>

        {!account ? (
          <>
            <p className="state-note">{t("shelf.noWallet")}</p>
            <p className="fine after-table">{t("shelf.connectHint")}</p>
            <button type="button" className="stamp-button" onClick={() => void connect()}>
              {t("nav.connect")}
            </button>
          </>
        ) : (
          <>
            {!boxesKnown ? (
              <p className="state-note">{t("mine.findAbove")}</p>
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
                        <button type="button" onClick={() => onPair(b.tokenId, "duel")} disabled={!!action.busy}>
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

            <label className="fine hide-among">
              {t("shelf.hideAmong")}{" "}
              <select value={among} onChange={(e) => setIds(Number(e.target.value))} disabled={!!action.busy}>
                {Array.from({ length: maxPerTx - quantity + 1 }, (_, i) => quantity + i).map((n) => (
                  <option key={n} value={n}>
                    {t("shelf.ids", { count: n })}
                  </option>
                ))}
              </select>
            </label>
            <p className="fine">{among === quantity ? t("shelf.hideNone", { count: quantity }) : t("shelf.hideHint", { ids: among, count: quantity })}</p>

            <PayWith busy={action.busy} need={total} />
            {pay === "usdc" && <p className="fine problem">{t("shelf.usdcShows")}</p>}

            <div className="felt" aria-live="polite">
              {action.error ? (
                <p className="fine problem">{action.error}</p>
              ) : action.busy ? (
                <p className="fine">{stepCopy(action.step, action.busy === "mint" || action.busy === "collect")}</p>
              ) : arrived.length ? (
                <p className="fine">{t("shelf.arrived", { serials: arrived.map((id) => buildBoxSpec(id).serial).join(", ") })}</p>
              ) : earned !== null ? (
                <p className="fine">{earned > 0n ? t("shelf.earned", { fee: fee(earned, collection) }) : t("shelf.earnedNothing")}</p>
              ) : (
                <p className="fine">
                  {t("shelf.price", { count: quantity, fee: fee(total, collection, pay) })}
                  {mode === "mock" ? t("shelf.mockFree") : ""}
                </p>
              )}
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
          </>
        )}
      </section>
    </>
  );
}
