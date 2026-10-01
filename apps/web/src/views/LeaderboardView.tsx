import { useEffect, useMemo, useState } from "react";
import { sameAddress, shortAddress, type Address, type OpenedCat } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useChain } from "../chain/ChainProvider";
import { catFromRevealed } from "../chain/copy";
import { useT } from "../i18n/app";
import { catNames } from "../i18n/names";
import { ShelfScene, SpecimenScene } from "../scenes/Scenes";
import { Stage } from "./Stage";
import { useFold } from "./useFold";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
}

/** Cats shown in 3D behind the ranking. */
const PODIUM = 3;

type Board = "cats" | "players";

interface Player {
  address: Address;
  /** Their cats, best first. */
  cats: OpenedCat[];
}

/**
 * Who holds a box is secret until its holder opens it: opening publishes the cat and who
 * opened it. So the leaderboard only knows opened cats, and the players who opened them.
 */
export function LeaderboardView({ quality, sound, onSelect }: Props) {
  const { adapter, account, collection } = useChain();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const [opened, setOpened] = useState<OpenedCat[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [board, setBoard] = useState<Board>("cats");
  const [selected, setSelected] = useState(0);
  // Read again when the sale moves: a new milestone, a new box.
  const stamp = collection?.tokenCount;

  useEffect(() => {
    let live = true;
    void adapter
      .openedCats()
      .then((all) => live && setOpened(all))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [adapter, stamp]);

  // Ranked by rarity score. Ties go to the lower serial: it was there first.
  const cats = useMemo(
    () =>
      (opened ?? [])
        .map((o) => ({ o, cat: catFromRevealed(o.revealed) }))
        .sort((a, b) => b.o.revealed.score - a.o.revealed.score || a.o.tokenId - b.o.tokenId),
    [opened],
  );
  // Players ranked by their best cat, then by how many they opened.
  const players = useMemo(() => {
    const by = new Map<string, Player>();
    for (const { o } of cats) {
      const key = o.openedBy.toLowerCase();
      const p = by.get(key) ?? { address: o.openedBy, cats: [] };
      p.cats.push(o);
      by.set(key, p);
    }
    return [...by.values()].sort((a, b) => b.cats[0]!.revealed.score - a.cats[0]!.revealed.score || b.cats.length - a.cats.length);
  }, [cats]);

  const podium = useMemo(() => cats.slice(0, PODIUM).map((c) => c.cat), [cats]);
  const showCats = podium.length > 0;
  const who = (a: Address) => (sameAddress(a, account) ? t("holder.you") : shortAddress(a));

  return (
    <>
      <Stage quality={quality}>
        {showCats ? (
          <SpecimenScene specs={podium} selected={Math.min(selected, podium.length - 1)} onSelect={setSelected} />
        ) : (
          <ShelfScene boxes={[]} quality={quality} sound={sound} onSelect={onSelect} />
        )}
      </Stage>

      <section className={`${showCats ? "slip declaration" : "slip"}${foldClass}`} aria-label={t("lb.title")}>
        {foldButton}
        <div className="slip-head">
          <span>{t("lb.title")}</span>
          <div className="picker" role="group" aria-label={t("lb.ranking")}>
            <button type="button" aria-pressed={board === "cats"} onClick={() => setBoard("cats")}>
              {t("lb.cats")}
            </button>
            <button type="button" aria-pressed={board === "players"} onClick={() => setBoard("players")}>
              {t("lb.players")}
            </button>
          </div>
        </div>

        {failed ? (
          <p className="fine problem">{t("lb.failed")}</p>
        ) : !opened ? (
          <p className="state-note">{t("lb.reading")}</p>
        ) : cats.length === 0 ? (
          <p className="state-note">{t("lb.noneOpened")}</p>
        ) : board === "cats" ? (
          <ol className="ranking">
            {cats.map(({ o, cat }, i) => {
              const names = catNames(cat);
              return (
                <li key={o.tokenId}>
                  <button
                    type="button"
                    onClick={() => (i < podium.length ? setSelected(i) : onSelect(o.tokenId))}
                    onDoubleClick={() => onSelect(o.tokenId)}
                    aria-pressed={i === selected && i < podium.length}
                  >
                    <span className="rank">{i + 1}</span>
                    <span className="who">
                      <strong>{buildBoxSpec(o.tokenId).serial}</strong> {t("lb.cat", { state: names.state.toLowerCase(), breed: names.breed.toLowerCase() })}
                      <small>
                        {names.tier}
                        {cat.rarity.golden ? t("lb.golden") : ""}
                        {sameAddress(o.openedBy, account) ? t("lb.openedByYou") : t("lb.openedBy", { who: shortAddress(o.openedBy) })}
                      </small>
                    </span>
                    <span className="roll">{o.revealed.score}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <ol className="ranking">
            {players.map((p, i) => (
              <li key={p.address}>
                <button type="button" onClick={() => onSelect(p.cats[0]!.tokenId)}>
                  <span className="rank">{i + 1}</span>
                  <span className="who">
                    <strong>{who(p.address)}</strong>
                    <small>{t("lb.playerCats", { count: p.cats.length, best: buildBoxSpec(p.cats[0]!.tokenId).serial })}</small>
                  </span>
                  <span className="roll">{p.cats[0]!.revealed.score}</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {opened && !failed && cats.length > 0 && (
          <p className="fine after-table">{board === "cats" ? t("lb.rankedPodium", { n: podium.length }) : t("lb.rankedPlayers")}</p>
        )}
        <p className="fine">{t("lb.onlyOpened")}</p>
      </section>
    </>
  );
}
