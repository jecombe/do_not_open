import { useEffect, useMemo, useState } from "react";
import type { BoxInfo } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { catFromRevealed, fee, stepCopy } from "../chain/copy";
import { useT } from "../i18n/app";
import { SHELF_CAPACITY, ShelfScene, type ShelfBox } from "../scenes/Scenes";
import { Stage } from "./Stage";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
}

/** How many of the account's boxes are read and listed. The newest come first. */
const LIST_LIMIT = 40;

export function ShelfView({ quality, sound, onSelect }: Props) {
  const { adapter, account, collection, myBoxes, refresh, connect, mode } = useChain();
  const t = useT();
  const action = useAction();
  const [quantity, setQuantity] = useState(1);
  const [infos, setInfos] = useState<BoxInfo[]>([]);
  const [owed, setOwed] = useState(0n);
  const [arrived, setArrived] = useState<number[]>([]);

  const listed = useMemo(() => [...myBoxes].reverse().slice(0, LIST_LIMIT), [myBoxes]);

  useEffect(() => {
    let live = true;
    void Promise.all(listed.map((id) => adapter.box(id)))
      .then((boxes) => live && setInfos(boxes))
      .catch(() => live && setInfos([]));
    if (account) void adapter.credits(account).then((c) => live && setOwed(c)).catch(() => undefined);
    else setOwed(0n);
    return () => {
      live = false;
    };
  }, [adapter, account, listed]);

  const onBench: ShelfBox[] = useMemo(
    () => infos.slice(0, SHELF_CAPACITY).map((b) => ({ tokenId: b.tokenId, cat: b.revealed ? catFromRevealed(b.revealed) : null })),
    [infos],
  );

  const mint = async () => {
    sound.resume();
    const ids = await action.run("mint", (o) => adapter.mint(quantity, o));
    if (!ids) return;
    setArrived(ids);
    await refresh();
  };

  const claim = async () => {
    if ((await action.run("claim", (o) => adapter.claim(o))) === undefined) return;
    setOwed(0n);
  };

  const maxPerTx = collection?.maxPerTx ?? 1;
  const left = collection ? collection.maxSupply - collection.totalMinted : 0;
  const total = collection ? collection.fees.mint * BigInt(quantity) : 0n;

  return (
    <>
      <Stage quality={quality}>
        <ShelfScene boxes={onBench} quality={quality} sound={sound} onSelect={onSelect} />
      </Stage>

      <section className="slip" aria-label={t("shelf.title")}>
        <div className="slip-head">
          <span>{t("shelf.title")}</span>
          {collection && <span>{t("shelf.shipped", { minted: collection.totalMinted, max: collection.maxSupply })}</span>}
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
            {myBoxes.length === 0 ? (
              <p className="state-note">{t("shelf.empty")}</p>
            ) : (
              <ul className="tags" aria-label={t("shelf.boxes")}>
                {(infos.length ? infos : listed.map((tokenId) => ({ tokenId, status: null }))).map((b) => (
                  <li key={b.tokenId}>
                    <button type="button" onClick={() => onSelect(b.tokenId)} className={b.status === "revealed" ? "is-open" : ""}>
                      {buildBoxSpec(b.tokenId).serial}
                      <span>{b.status === null ? "…" : b.status === "revealed" ? t("status.open") : b.status === "opening" ? t("status.opening") : t("status.sealed")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {myBoxes.length > LIST_LIMIT && <p className="fine">{t("shelf.showing", { limit: LIST_LIMIT, total: myBoxes.length })}</p>}

            <div className="order">
              <div className="stepper" role="group" aria-label={t("shelf.howMany")}>
                <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={!!action.busy || quantity <= 1} aria-label={t("shelf.fewer")}>
                  −
                </button>
                <output aria-live="polite">{quantity}</output>
                <button type="button" onClick={() => setQuantity((q) => Math.min(maxPerTx, left, q + 1))} disabled={!!action.busy || quantity >= Math.min(maxPerTx, left)} aria-label={t("shelf.more")}>
                  +
                </button>
              </div>
              <button type="button" className="stamp-button" onClick={() => void mint()} disabled={!!action.busy || !collection || left === 0}>
                {action.busy === "mint" ? t("shelf.ordering") : left === 0 ? t("shelf.soldOut") : t("shelf.mint", { count: quantity })}
              </button>
            </div>

            <div className="felt" aria-live="polite">
              {action.error ? (
                <p className="fine problem">{action.error}</p>
              ) : action.busy ? (
                <p className="fine">{stepCopy(action.step)}</p>
              ) : arrived.length ? (
                <p className="fine">{t("shelf.arrived", { serials: arrived.map((id) => buildBoxSpec(id).serial).join(", ") })}</p>
              ) : (
                <p className="fine">
                  {t("shelf.price", { count: quantity, fee: fee(total, collection) })}
                  {mode === "mock" ? t("shelf.mockFree") : ""}
                </p>
              )}
              {owed > 0n && !action.busy && (
                <p className="fine">
                  {t("shelf.owed", { fee: fee(owed, collection) })}{" "}
                  <button type="button" className="link" onClick={() => void claim()}>
                    {t("shelf.claim")}
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
