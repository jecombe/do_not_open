import { useEffect, useMemo, useState } from "react";
import type { BoxInfo } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useChain } from "../chain/ChainProvider";
import { catFromRevealed, holderCopy } from "../chain/copy";
import { useT } from "../i18n/app";
import { catNames } from "../i18n/names";
import { SHELF_CAPACITY, ShelfScene, SpecimenScene } from "../scenes/Scenes";
import { Stage } from "./Stage";
import { useFold } from "./useFold";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
}

/** The ranking reads this many of the most recent boxes. Beyond that it needs an indexer. */
const READ_LIMIT = 250;
/** Cats shown in 3D behind the opened ranking. */
const PODIUM = 3;

type Board = "opened" | "sealed";

export function LeaderboardView({ quality, sound, onSelect }: Props) {
  const { adapter, account, collection } = useChain();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const [boxes, setBoxes] = useState<BoxInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [board, setBoard] = useState<Board>("opened");
  const [selected, setSelected] = useState(0);
  const minted = collection?.totalMinted;

  useEffect(() => {
    if (minted === undefined) return;
    let live = true;
    const first = Math.max(0, minted - READ_LIMIT);
    const ids = Array.from({ length: minted - first }, (_, i) => first + i);
    void Promise.all(ids.map((id) => adapter.box(id)))
      .then((all) => live && setBoxes(all))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [adapter, minted]);

  // Opened boxes rank on what they revealed. Ties go to the lower serial: it was there first.
  const opened = useMemo(
    () =>
      (boxes ?? [])
        .filter((b) => b.revealed)
        .map((box) => ({ box, cat: catFromRevealed(box.revealed!) }))
        .sort((a, b) => b.box.revealed!.score - a.box.revealed!.score || a.box.tokenId - b.box.tokenId),
    [boxes],
  );
  // Sealed boxes have no public score. Duel wins are the only thing they can be ranked on.
  const sealed = useMemo(
    () => (boxes ?? []).filter((b) => !b.revealed).sort((a, b) => b.wins - a.wins || a.tokenId - b.tokenId),
    [boxes],
  );

  const podium = useMemo(() => opened.slice(0, PODIUM).map((o) => o.cat), [opened]);
  const bench = useMemo(() => sealed.slice(0, SHELF_CAPACITY).map((b) => ({ tokenId: b.tokenId, cat: null })), [sealed]);
  const showCats = board === "opened" && podium.length > 0;

  return (
    <>
      <Stage quality={quality}>
        {showCats ? (
          <SpecimenScene specs={podium} selected={Math.min(selected, podium.length - 1)} onSelect={setSelected} />
        ) : (
          <ShelfScene boxes={board === "sealed" ? bench : []} quality={quality} sound={sound} onSelect={onSelect} />
        )}
      </Stage>

      <section className={`${showCats ? "slip declaration" : "slip"}${foldClass}`} aria-label={t("lb.title")}>
        {foldButton}
        <div className="slip-head">
          <span>{t("lb.title")}</span>
          <div className="picker" role="group" aria-label={t("lb.ranking")}>
            <button type="button" aria-pressed={board === "opened"} onClick={() => setBoard("opened")}>
              {t("lb.opened")}
            </button>
            <button type="button" aria-pressed={board === "sealed"} onClick={() => setBoard("sealed")}>
              {t("lb.sealed")}
            </button>
          </div>
        </div>

        {failed ? (
          <p className="fine problem">{t("lb.failed")}</p>
        ) : !boxes ? (
          <p className="state-note">{t("lb.reading")}</p>
        ) : board === "opened" ? (
          opened.length === 0 ? (
            <p className="state-note">{t("lb.noneOpened")}</p>
          ) : (
            <ol className="ranking">
              {opened.map(({ box, cat }, i) => {
                const names = catNames(cat);
                return (
                  <li key={box.tokenId}>
                    <button
                      type="button"
                      onClick={() => (i < podium.length ? setSelected(i) : onSelect(box.tokenId))}
                      onDoubleClick={() => onSelect(box.tokenId)}
                      aria-pressed={showCats && i === selected}
                    >
                      <span className="rank">{i + 1}</span>
                      <span className="who">
                        <strong>{buildBoxSpec(box.tokenId).serial}</strong> {t("lb.cat", { state: names.state.toLowerCase(), breed: names.breed.toLowerCase() })}
                        <small>
                          {names.tier}
                          {cat.rarity.golden ? t("lb.golden") : ""}
                          {t("lb.heldBy", { holder: holderCopy(box.owner, account) })}
                        </small>
                      </span>
                      <span className="roll">{box.revealed!.score}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )
        ) : sealed.length === 0 ? (
          <p className="state-note">{t("lb.allOpened")}</p>
        ) : (
          <ol className="ranking">
            {sealed.map((box, i) => (
              <li key={box.tokenId}>
                <button type="button" onClick={() => onSelect(box.tokenId)}>
                  <span className="rank">{i + 1}</span>
                  <span className="who">
                    <strong>{buildBoxSpec(box.tokenId).serial}</strong>
                    <small>
                      {t("lb.heldBySealed", { holder: holderCopy(box.owner, account) })}
                      {box.aliveCheck === "alive" ? t("lb.vet") : ""}
                      {box.feeds ? t("lb.fed", { n: box.feeds }) : ""}
                    </small>
                  </span>
                  <span className="roll">{t("lb.wins", { count: box.wins })}</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {boxes && !failed && (board === "opened" ? opened : sealed).length > 0 && (
          <p className="fine after-table">
            {board === "opened" ? (showCats ? t("lb.rankedPodium", { n: podium.length }) : t("lb.ranked")) : t("lb.rankedSealed")}
            {minted !== undefined && minted > READ_LIMIT ? t("lb.onlyRecent", { n: READ_LIMIT }) : ""}
          </p>
        )}
      </section>
    </>
  );
}
