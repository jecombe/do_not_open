import { useEffect, useMemo, useState } from "react";
import { ROSETTES, sameAddress, shortAddress, type Address, type AllowListStatus, type OpenedCat } from "@dno/chain-adapter";
import { X_PASS_BONUS, xPassWalletMessage } from "@dno/chain-adapter/standings";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain, useLedger } from "../chain/ChainProvider";
import { useDuelStandings } from "../chain/standings";
import { catFromRevealed } from "../chain/copy";
import { useT } from "../i18n/app";
import { useLocale } from "../i18n/locale";
import { homePath } from "../site";
import { linkXPassWallet, useXPass, XPassError } from "../xpass";
import { catNames } from "../i18n/names";
import { ShelfScene, SpecimenScene, type ShelfBox } from "../scenes/Scenes";
import { ProblemNote } from "./ProblemNote";
import { Stage } from "./Stage";
import { useFold } from "./useFold";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  onSelect: (tokenId: number) => void;
}

/** `app?view=leaderboard&board=duels` opens on that ranking: where the home page's allow list line leads. */
const linkedBoard = (() => {
  const raw = new URLSearchParams(window.location.search).get("board");
  return raw === "players" || raw === "duels" ? raw : null;
})();

/** Cats shown in 3D behind the ranking. */
const PODIUM = 3;

type Board = "cats" | "players" | "duels";

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
  const { adapter, account, collection, connect } = useChain();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const [opened, setOpened] = useState<OpenedCat[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [board, setBoard] = useState<Board>(linkedBoard ?? "cats");
  const [selected, setSelected] = useState(0);
  // Read again when the sale moves: a new milestone, a new box.
  const stamp = collection?.tokenCount;
  const ledger = useLedger();
  const standings = useDuelStandings(ledger);

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
  const showCats = podium.length > 0 && board !== "duels";
  const revealedOf = useMemo(() => new Map((opened ?? []).map((o) => [o.tokenId, o.revealed])), [opened]);
  // The duel podium: the top three on the bench, each with its rosette, a cat beside its box once opened.
  const duelBench = useMemo<ShelfBox[]>(
    () =>
      (standings ?? [])
        .slice(0, ROSETTES)
        .filter((s) => s.wins > 0)
        .map((s, i) => {
          const r = revealedOf.get(s.tokenId);
          return { tokenId: s.tokenId, cat: r ? catFromRevealed(r) : null, rosette: { place: i + 1, wins: s.wins } };
        }),
    [standings, revealedOf],
  );
  const who = (a: Address) => (sameAddress(a, account) ? t("holder.you") : shortAddress(a));

  return (
    <>
      <Stage quality={quality}>
        {showCats ? (
          <SpecimenScene specs={podium} selected={Math.min(selected, podium.length - 1)} onSelect={setSelected} />
        ) : (
          <ShelfScene boxes={board === "duels" ? duelBench : []} quality={quality} sound={sound} onSelect={onSelect} />
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
            <button type="button" aria-pressed={board === "duels"} onClick={() => setBoard("duels")}>
              {t("lb.duels")}
            </button>
          </div>
        </div>

        {board === "duels" ? (
          <>
            {!standings ? (
              <p className="state-note">{t("lb.reading")}</p>
            ) : standings.length === 0 ? (
              <p className="state-note">{t("lb.noDuels")}</p>
            ) : (
              <ol className="ranking">
                {standings.map((s, i) => (
                  <li key={s.tokenId}>
                    <button type="button" onClick={() => onSelect(s.tokenId)}>
                      <span className={i < ROSETTES && s.wins > 0 ? `rank rosette-rank rosette-${i + 1}` : "rank"}>{i + 1}</span>
                      <span className="who">
                        <strong>{buildBoxSpec(s.tokenId).serial}</strong> {revealedOf.has(s.tokenId) ? t("lb.boxOpened") : t("lb.boxSealed")}
                        <small>{t("lb.duelRecord", { wins: s.wins, losses: s.losses })}</small>
                      </span>
                      <span className="roll">{s.wins}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {standings && standings.length > 0 && <p className="fine after-table">{t("lb.rankedDuels", { n: ROSETTES })}</p>}
            <AllowListPanel account={account} connect={connect} ledger={ledger} />
          </>
        ) : failed ? (
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

        {board !== "duels" && opened && !failed && cats.length > 0 && (
          <p className="fine after-table">{board === "cats" ? t("lb.rankedPodium", { n: podium.length }) : t("lb.rankedPlayers")}</p>
        )}
        {board !== "duels" && <p className="fine">{t("lb.onlyOpened")}</p>}
      </section>
    </>
  );
}

/**
 * The mainnet allow list: a player claims a place by signing, free. Points come only from what
 * the chain already made public about the address, and nobody is ranked who did not ask.
 */
function AllowListPanel({ account, connect, ledger }: { account: Address | null; connect: () => Promise<void>; ledger: number }) {
  const { adapter } = useChain();
  const t = useT();
  const action = useAction();
  const [status, setStatus] = useState<AllowListStatus | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setStatus(undefined);
    if (!account) return;
    adapter.allowList().then(
      (s) => live && setStatus(s),
      () => live && setStatus(null),
    );
    return () => {
      live = false;
    };
  }, [adapter, account, ledger]);

  const claim = async () => {
    const s = await action.run("allowlist", () => adapter.claimAllowList());
    if (s) setStatus(s);
  };

  return (
    <div className="allow-list">
      <h3>{t("al.title")}</h3>
      <p className="fine">{t("al.intro")}</p>
      {!account ? (
        <button type="button" className="stamp-button" onClick={() => void connect()}>
          {t("al.connect")}
        </button>
      ) : status === undefined ? (
        <p className="state-note">{t("al.reading")}</p>
      ) : status === null ? (
        <p className="fine">{t("al.unavailable")}</p>
      ) : (
        <>
          <p className="allow-points">
            <strong>{t("al.points", { count: status.points })}</strong>
            <small>{t("al.breakdown", { beaten: status.live.beaten, faced: status.live.faced, opened: status.live.opened })}</small>
          </p>
          {status.rank !== null ? (
            <p className={status.places === null || status.rank <= status.places ? "fine mark-good" : "fine"}>
              {t(status.places === null || status.rank <= status.places ? "al.inPlace" : "al.outOfPlace", { rank: status.rank, claimants: status.claimants, places: status.places ?? 0 })}
            </p>
          ) : (
            <p className="fine">{t("al.notClaimed", { claimants: status.claimants, places: status.places ?? 0 })}</p>
          )}
          <button type="button" className="stamp-button" onClick={() => void claim()} disabled={!!action.busy}>
            {action.busy ? t("al.signing") : status.rank === null ? t("al.claim") : t("al.update")}
          </button>
          {action.error && <ProblemNote problem={action.error} />}
          <XPassLink account={account} onLinked={() => void adapter.allowList().then((s) => s && setStatus(s), () => undefined)} />
        </>
      )}
      <p className="fine">{t("al.rules")}</p>
    </div>
  );
}

/**
 * The X boarding pass this browser holds (from the home page), and linking it to the connected
 * wallet: a free signature adds its bonus to the wallet's points. The link stays private.
 */
function XPassLink({ account, onLinked }: { account: Address; onLinked: () => void }) {
  const { adapter } = useChain();
  const t = useT();
  const locale = useLocale();
  const action = useAction();
  const { pass, set } = useXPass();
  const [refused, setRefused] = useState<string | null>(null);

  if (!pass?.handle) {
    return (
      <p className="fine xpass-line">
        <a href={`${homePath(locale)}#boarding`}>{t("xpass.connect", { bonus: X_PASS_BONUS })}</a>
      </p>
    );
  }
  if (pass.address && sameAddress(pass.address, account)) {
    return <p className="fine mark-good xpass-line">{t("xpass.linked", { handle: pass.handle, bonus: X_PASS_BONUS })}</p>;
  }

  const link = async () => {
    setRefused(null);
    const message = xPassWalletMessage(account, pass.code, new Date());
    const signature = await action.run("xpass", () => adapter.signText(message));
    if (!signature) return;
    try {
      set(await linkXPassWallet(account, message, signature));
      onLinked();
    } catch (e) {
      setRefused(e instanceof XPassError && e.code === "address-taken" ? t("xpass.taken") : t("xpass.failed"));
    }
  };

  return (
    <div className="xpass-line">
      {pass.address && <p className="fine">{t("xpass.other", { handle: pass.handle })}</p>}
      <button type="button" className="stamp-button" onClick={() => void link()} disabled={!!action.busy}>
        {action.busy === "xpass" ? t("al.signing") : t("xpass.link", { handle: pass.handle, bonus: X_PASS_BONUS })}
      </button>
      {action.error && <ProblemNote problem={action.error} />}
      {refused && <p className="fine">{refused}</p>}
      <p className="fine">{t("xpass.private")}</p>
    </div>
  );
}
