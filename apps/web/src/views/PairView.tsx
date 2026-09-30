import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sameAddress, type BoxInfo, type DuelResult, type PairInfo } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { catFromRevealed, fee, holderCopy, stepCopy, traitCopy } from "../chain/copy";
import { useT, type AppKey } from "../i18n/app";
import { catNames } from "../i18n/names";
import { PairScene, type PairSceneHandle } from "../scenes/Scenes";
import { Stage } from "./Stage";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  /** Boxes to start on. A second id of -1 means "pick any other box". */
  initial: [number, number] | null;
  onInspect: (tokenId: number) => void;
}

/** The pickers list this many of the most recent boxes, plus the account's own. */
const PICK_LIMIT = 200;
const serial = (id: number) => buildBoxSpec(id).serial;

/** A note is stored as a message key, so it follows a language change. */
type Note = Extract<AppKey, "pair.noteChallenge" | "pair.noteProposal">;

export function PairView({ quality, sound, initial, onInspect }: Props) {
  const { adapter, account, collection, myBoxes, refresh, connect } = useChain();
  const t = useT();
  const scene = useRef<PairSceneHandle>(null);
  const action = useAction();
  const minted = collection?.totalMinted ?? 0;

  const [picked, setPicked] = useState<[number, number] | null>(initial && initial[1] >= 0 ? initial : null);
  const [boxes, setBoxes] = useState<[BoxInfo, BoxInfo] | null>(null);
  const [standing, setStanding] = useState<PairInfo | null>(null);
  const [outcome, setOutcome] = useState<DuelResult | null>(null);
  const [playing, setPlaying] = useState<null | "duel" | "open">(null);
  const [note, setNote] = useState<Note | null>(null);

  // First pair: the requested box (or the account's first) against any other one.
  useEffect(() => {
    if (picked || minted < 2) return;
    const a = initial?.[0] ?? myBoxes[0] ?? 0;
    const b = myBoxes.find((id) => id !== a) ?? (a === 0 ? 1 : 0);
    setPicked([a, b]);
  }, [picked, minted, initial, myBoxes]);

  const [a, b] = picked ?? [0, 1];

  const load = useCallback(async () => {
    if (!picked) return;
    try {
      const [boxA, boxB, pair] = await Promise.all([adapter.box(picked[0]), adapter.box(picked[1]), adapter.pair(picked[0], picked[1])]);
      setBoxes([boxA, boxB]);
      setStanding(pair);
    } catch {
      setBoxes(null);
    }
  }, [adapter, picked]);

  const { reset } = action;
  useEffect(() => {
    setBoxes(null);
    setStanding(null);
    setOutcome(null);
    setPlaying(null);
    setNote(null);
    reset();
    void load();
  }, [load, reset]);

  const options = useMemo(() => {
    const ids = new Set<number>([...myBoxes, a, b]);
    for (let id = minted - 1; id >= 0 && ids.size < PICK_LIMIT; id--) ids.add(id);
    return [...ids].filter((id) => id < minted).sort((x, y) => x - y);
  }, [myBoxes, minted, a, b]);

  const mine = (id: number) => myBoxes.includes(id);
  const [boxA, boxB] = boxes ?? [null, null];
  const catA = useMemo(() => (boxA?.revealed ? catFromRevealed(boxA.revealed) : null), [boxA]);
  const catB = useMemo(() => (boxB?.revealed ? catFromRevealed(boxB.revealed) : null), [boxB]);
  const entangled = !!boxA && boxA.partner === b;
  const bothSealed = boxA?.status === "sealed" && boxB?.status === "sealed";
  const busy = action.busy ?? playing;

  const onDuelDone = useCallback(() => setPlaying(null), []);
  const onOpened = useCallback(() => setPlaying(null), []);

  const start = () => {
    sound.resume();
    setNote(null);
    setOutcome(null);
  };

  // --- duel: challenge, accept, reveal. One click runs every step this account may take.
  const duel = standing?.openDuel ?? null;
  const challenger = mine(a) ? a : mine(b) ? b : null;
  const duelStep: "challenge" | "accept" | "waiting" | "reveal" | null = !bothSealed
    ? null
    : !duel
      ? challenger !== null
        ? "challenge"
        : null
      : duel.status === "pending"
        ? "reveal"
        : mine(duel.tokenB)
          ? "accept"
          : "waiting";

  const runDuel = async () => {
    start();
    const result = await action.run("duel", async (o) => {
      let d = (await adapter.pair(a, b)).openDuel;
      if (!d) {
        const from = challenger!;
        await adapter.challengeDuel(from, from === a ? b : a, o);
        d = (await adapter.pair(a, b)).openDuel;
      }
      if (d?.status === "challenged") {
        if (!sameAddress((await adapter.box(d.tokenB)).owner, account)) return "waiting" as const;
        await adapter.acceptDuel(d.duelId, o);
        d = { ...d, status: "pending" };
      }
      return d ? adapter.finishDuel(d.duelId, o) : ("waiting" as const);
    });
    if (result === undefined || result === "waiting") {
      if (result === "waiting") setNote("pair.noteChallenge");
      void load();
      return;
    }
    setOutcome(result);
    if (scene.current) {
      setPlaying("duel");
      scene.current.duel(result.winner === a);
    }
    void load();
  };

  const cancelDuel = async () => {
    if (!duel) return;
    start();
    await action.run("cancel", (o) => adapter.cancelDuel(duel.duelId, o));
    void load();
  };

  // --- entangle: propose, then the other holder accepts.
  const proposal = standing?.entangleProposal ?? null;
  const taken = !!boxA && !!boxB && !entangled && (boxA.partner !== null || boxB.partner !== null);
  const linkStep: "propose" | "accept" | "waiting" | null = !bothSealed || entangled || taken ? null : !proposal ? (challenger !== null ? "propose" : null) : mine(proposal.to) ? "accept" : "waiting";

  const runEntangle = async () => {
    start();
    const linked = await action.run("entangle", async (o) => {
      let p = (await adapter.pair(a, b)).entangleProposal;
      if (!p) {
        const from = challenger!;
        const to = from === a ? b : a;
        await adapter.proposeEntangle(from, to, o);
        // The other holder may already have said yes (the mock's night shift does).
        if ((await adapter.box(from)).partner === to) return true;
        p = { from, to, proposer: account! };
      }
      if (!sameAddress((await adapter.box(p.to)).owner, account)) return false;
      await adapter.acceptEntangle(p.from, p.to, o);
      return true;
    });
    if (linked) sound.reveal(false);
    if (linked === false) setNote("pair.noteProposal");
    void load();
  };

  // --- open: whichever of the two this account holds, A first.
  const openable = [boxA, boxB].find((x) => x && mine(x.tokenId) && x.status !== "revealed") ?? null;

  const open = async () => {
    if (!openable) return;
    start();
    const id = openable.tokenId;
    const opened = await action.run("open", (o) => (openable.status === "opening" ? adapter.finishObserve(id, o) : adapter.observe(id, o)));
    if (!opened) {
      void load();
      return;
    }
    const reveal = (tokenId: number) => {
      const r = opened.find((x) => x.tokenId === tokenId)?.revealed;
      return r ? catFromRevealed(r) : null;
    };
    if (scene.current) {
      setPlaying("open");
      scene.current.open(catA ? null : reveal(a), catB ? null : reveal(b));
    }
    await load();
    void refresh();
  };

  if (minted < 2) {
    return (
      <>
        <Stage quality={quality}>
          <PairScene ref={scene} tokenA={0} tokenB={1} openedA={null} openedB={null} entangled={false} quality={quality} sound={sound} onDuelDone={onDuelDone} onOpened={onOpened} />
        </Stage>
        <section className="slip" aria-label={t("pair.aria")}>
          <div className="slip-head">
            <span>{t("pair.title")}</span>
          </div>
          <p className="state-note">{collection ? t("pair.needTwo") : t("footer.reading")}</p>
        </section>
      </>
    );
  }

  const opened = [boxA, boxB].filter((x): x is BoxInfo => !!x?.revealed);
  const showResults = opened.length > 0 && playing !== "open";
  const status = (x: BoxInfo) => (x.status === "revealed" ? t("status.open") : x.status === "opening" ? t("status.opening") : t("status.sealed"));

  return (
    <>
      <Stage quality={quality}>
        <PairScene
          ref={scene}
          tokenA={a}
          tokenB={b}
          openedA={catA}
          openedB={catB}
          entangled={entangled}
          quality={quality}
          sound={sound}
          onDuelDone={onDuelDone}
          onOpened={onOpened}
        />
      </Stage>

      <section className="slip" aria-label={t("pair.aria")}>
        <div className="slip-head">
          <span>{t("pair.title")}</span>
          {entangled && <span className="tier tier-entangled">{t("pair.entangled")}</span>}
        </div>

        <div className="pair-pick">
          {([0, 1] as const).map((slot) => (
            <label key={slot}>
              {slot === 0 ? t("pair.left") : t("pair.right")}
              <select
                value={slot === 0 ? a : b}
                disabled={!!busy}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  const other = slot === 0 ? b : a;
                  // Picking the box that is already on the other side swaps them.
                  setPicked(slot === 0 ? [id, id === other ? a : other] : [id === other ? b : other, id]);
                }}
              >
                {options.map((id) => (
                  <option key={id} value={id}>
                    {serial(id)}
                    {mine(id) ? t("pair.yours") : ""}
                  </option>
                ))}
              </select>
              <span className="fine">
                {(() => {
                  const x = slot === 0 ? boxA : boxB;
                  if (!x) return "…";
                  return t("pair.status", { holder: holderCopy(x.owner, account), state: status(x) }) + (x.wins ? t("pair.won", { n: x.wins }) : "");
                })()}
              </span>
            </label>
          ))}
        </div>

        {showResults && (
          <ul className="results">
            {opened.map((x) => {
              const names = catNames(catFromRevealed(x.revealed!));
              return (
                <li key={x.tokenId}>
                  <strong>{serial(x.tokenId)}</strong>
                  {t("pair.result", { state: names.state.toLowerCase(), breed: names.breed.toLowerCase(), tier: names.tier.toLowerCase(), score: x.revealed!.score })}
                  <button type="button" className="link" onClick={() => onInspect(x.tokenId)}>
                    {t("pair.takeOut")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {!account ? (
          <div className="actions">
            <button type="button" className="stamp-button" onClick={() => void connect()}>
              {t("nav.connect")}
            </button>
          </div>
        ) : (
          opened.length < 2 && (
            <div className="actions">
              <button type="button" className="stamp-button" onClick={() => void runDuel()} disabled={!!busy || !duelStep || duelStep === "waiting"}>
                {busy === "duel"
                  ? t("pair.fighting")
                  : duelStep === "accept"
                    ? t("pair.acceptDuel")
                    : duelStep === "reveal"
                      ? t("pair.reveal")
                      : duelStep === "waiting"
                        ? t("pair.challengeSent")
                        : t("pair.startDuel")}
              </button>
              <button type="button" className="plain-button" onClick={() => void runEntangle()} disabled={!!busy || !linkStep || linkStep === "waiting"}>
                {busy === "entangle" ? t("pair.linking") : entangled ? t("pair.entangled") : linkStep === "accept" ? t("pair.acceptLink") : linkStep === "waiting" ? t("pair.linkProposed") : t("pair.entangle")}
              </button>
              <button type="button" className="plain-button" onClick={() => void open()} disabled={!!busy || !openable}>
                {busy === "open"
                  ? t("box.opening")
                  : openable
                    ? t(openable.status === "opening" ? "pair.finish" : "pair.openSerial", { serial: serial(openable.tokenId) })
                    : t("pair.open")}
              </button>
            </div>
          )
        )}

        <div className="felt" aria-live="polite">
          {action.error ? (
            <p className="fine problem">{action.error}</p>
          ) : action.busy ? (
            <p className="fine">{stepCopy(action.step)}</p>
          ) : outcome && playing !== "duel" ? (
            <>
              <p className="felt-line">
                <strong>{serial(outcome.winner)}</strong>
                {t("pair.wins")}
              </p>
              <p className="fine">
                {t("pair.loserShows", { loser: serial(outcome.loser), trait: traitCopy(outcome.shown).trait })}
                <strong>{traitCopy(outcome.shown).variant}</strong>
                {t("pair.winnerNothing")}
              </p>
            </>
          ) : note ? (
            <p className="fine">{t(note)}</p>
          ) : showResults ? (
            <p className="fine">{opened.length === 2 && entangled ? t("pair.bothOpenedEntangled") : opened.length === 2 ? t("pair.bothOpen") : t("pair.otherSealed")}</p>
          ) : !boxes ? null : !account ? (
            <p className="fine">{t("pair.duelConnect")}</p>
          ) : duelStep === "waiting" && duel ? (
            <p className="fine">
              {t("pair.waiting", { a: serial(duel.tokenA), b: serial(duel.tokenB) })}
              {sameAddress(duel.challenger, account) && (
                <button type="button" className="link" onClick={() => void cancelDuel()}>
                  {t("pair.withdraw")}
                </button>
              )}
            </p>
          ) : duelStep === "accept" && duel ? (
            <p className="fine">{t("pair.acceptExplain", { a: serial(duel.tokenA), b: serial(duel.tokenB) })}</p>
          ) : duelStep === "reveal" ? (
            <p className="fine">{t("pair.revealExplain")}</p>
          ) : linkStep === "accept" && proposal ? (
            <p className="fine">{t("pair.linkExplain", { from: serial(proposal.from), to: serial(proposal.to) })}</p>
          ) : entangled ? (
            <p className="fine">{t("pair.entangledExplain", { fee: fee(collection?.fees.observe ?? 0n, collection) })}</p>
          ) : taken ? (
            <p className="fine">{t("pair.taken")}</p>
          ) : challenger === null ? (
            <p className="fine">{t("pair.neither")}</p>
          ) : (
            <p className="fine">{t("pair.duelExplain")}</p>
          )}
        </div>
      </section>
    </>
  );
}
