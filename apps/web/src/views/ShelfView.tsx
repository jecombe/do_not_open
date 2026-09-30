import { useEffect, useMemo, useState } from "react";
import type { BoxInfo } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { catFromRevealed, fee, stepCopy } from "../chain/copy";
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

      <section className="slip" aria-label="Your shelf">
        <div className="slip-head">
          <span>Your shelf</span>
          {collection && (
            <span>
              {collection.totalMinted.toLocaleString("en")} of {collection.maxSupply.toLocaleString("en")} shipped
            </span>
          )}
        </div>

        {!account ? (
          <>
            <p className="state-note">No wallet connected.</p>
            <p className="fine after-table">Connect one to see the boxes you hold and to order new ones.</p>
            <button type="button" className="stamp-button" onClick={() => void connect()}>
              Connect wallet
            </button>
          </>
        ) : (
          <>
            {myBoxes.length === 0 ? (
              <p className="state-note">Nothing on your shelf yet.</p>
            ) : (
              <ul className="tags" aria-label="Your boxes">
                {(infos.length ? infos : listed.map((tokenId) => ({ tokenId, status: null }))).map((b) => (
                  <li key={b.tokenId}>
                    <button type="button" onClick={() => onSelect(b.tokenId)} className={b.status === "revealed" ? "is-open" : ""}>
                      {buildBoxSpec(b.tokenId).serial}
                      <span>{b.status === null ? "…" : b.status === "revealed" ? "open" : b.status === "opening" ? "opening" : "sealed"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {myBoxes.length > LIST_LIMIT && <p className="fine">Showing your {LIST_LIMIT} newest boxes of {myBoxes.length}.</p>}

            <div className="order">
              <div className="stepper" role="group" aria-label="How many boxes">
                <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={!!action.busy || quantity <= 1} aria-label="One fewer">
                  −
                </button>
                <output aria-live="polite">{quantity}</output>
                <button type="button" onClick={() => setQuantity((q) => Math.min(maxPerTx, left, q + 1))} disabled={!!action.busy || quantity >= Math.min(maxPerTx, left)} aria-label="One more">
                  +
                </button>
              </div>
              <button type="button" className="stamp-button" onClick={() => void mint()} disabled={!!action.busy || !collection || left === 0}>
                {action.busy === "mint" ? "Ordering…" : left === 0 ? "Sold out" : `Mint ${quantity} box${quantity > 1 ? "es" : ""}`}
              </button>
            </div>

            <div className="felt" aria-live="polite">
              {action.error ? (
                <p className="fine problem">{action.error}</p>
              ) : action.busy ? (
                <p className="fine">{stepCopy(action.step)}</p>
              ) : arrived.length ? (
                <p className="fine">
                  {arrived.map((id) => buildBoxSpec(id).serial).join(", ")} arrived sealed. Nobody knows what is inside, the depot included.
                </p>
              ) : (
                <p className="fine">
                  {fee(total, collection)} for {quantity > 1 ? `${quantity} boxes` : "one box"}. Each arrives sealed, its contents drawn and encrypted on-chain.
                  {mode === "mock" ? " Nothing is charged in the mock depot." : ""}
                </p>
              )}
              {owed > 0n && !action.busy && (
                <p className="fine">
                  Strangers paid to shake your boxes: {fee(owed, collection)} is waiting.{" "}
                  <button type="button" className="link" onClick={() => void claim()}>
                    Claim it
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
