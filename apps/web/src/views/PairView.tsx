import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sameAddress, type ActionOptions, type BoxInfo, type BoxSummary, type DuelInfo, type DuelResult, type PairInfo } from "@dno/chain-adapter";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { catFromRevealed, fee, holderCopy, stepCopy, traitCopy } from "../chain/copy";
import { usePayment } from "../chain/payment";
import { FindMine } from "./FindMine";
import { logTx, recallTxs, type LoggedTx } from "../chain/txLog";
import { useT, type AppKey } from "../i18n/app";
import { useLocale } from "../i18n/locale";
import { catNames } from "../i18n/names";
import { PairScene, type PairSceneHandle } from "../scenes/Scenes";
import { Stage } from "./Stage";
import { StepTracker, type PlannedStep } from "./StepTracker";
import { TxJournal } from "./TxJournal";
import { useFold } from "./useFold";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  /** Boxes to start on. A second id of -1 means "pick any other box". */
  initial: [number, number] | null;
  intent: PairIntent | null;
  onInspect: (tokenId: number) => void;
}

/** What the holder came to do. Unset, both actions are offered. */
export type PairIntent = "duel" | "entangle";

/** The pickers draw from this many of the most recent boxes, plus the account's own. */
const PICK_LIMIT = 200;
const summaryOf = (x: BoxInfo): BoxSummary => ({ tokenId: x.tokenId, mine: x.mine, status: x.status, partner: x.status === "sealed" ? x.partner : null });
const serial = (id: number) => buildBoxSpec(id).serial;

/** A note is stored as a message key, so it follows a language change. */
type Note = Extract<AppKey, "pair.noteChallenge" | "pair.noteProposal" | "pair.noteVoid">;

const SIGN_AND_MINE = (label: AppKey): PlannedStep[] => [
  { step: "wallet", label },
  { step: "confirming", label: "track.chain" },
];
const PROVE_HOLDING: PlannedStep[] = [
  { step: "decrypting", label: "track.decryptHolding" },
  { step: "proving", label: "track.proof" },
];
const DECIDE: PlannedStep[] = [
  { step: "decrypting", label: "track.decryptDuel" },
  { step: "proving", label: "track.proof" },
];
const OPEN_PLAN: PlannedStep[] = [...SIGN_AND_MINE("track.sign"), { step: "decrypting", label: "track.decryptPublic" }, { step: "proving", label: "track.proof" }];

export function PairView({ quality, sound, initial, intent, onInspect }: Props) {
  const { adapter, account, collection, myBoxes, boxesKnown, refresh, connect } = useChain();
  const pay = usePayment();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const scene = useRef<PairSceneHandle>(null);
  const action = useAction();
  const minted = collection?.tokenCount ?? 0;

  const [picked, setPicked] = useState<[number, number] | null>(initial && initial[1] >= 0 ? initial : null);
  const [loaded, setLoaded] = useState<{ boxes: [BoxInfo, BoxInfo]; standing: PairInfo } | null>(null);
  const [outcome, setOutcome] = useState<DuelResult | null>(null);
  const [playing, setPlaying] = useState<null | "duel" | "open">(null);
  const [note, setNote] = useState<Note | null>(null);
  const [focus, setFocus] = useState<PairIntent | null>(intent);
  // The menu clears the intent while this view is still on screen.
  useEffect(() => setFocus(intent), [intent]);
  const offerDuel = focus !== "entangle";
  const offerLink = focus !== "duel";
  const [plan, setPlan] = useState<PlannedStep[] | null>(null);
  const [txs, setTxs] = useState<LoggedTx[]>([]);
  const locale = useLocale();
  const contract = collection?.address ?? "";

  // The boxes the pickers draw from: the newest ones, and every one the account holds.
  const [pool, setPool] = useState<BoxSummary[] | null>(null);
  useEffect(() => {
    if (minted < 2) return;
    let live = true;
    const lo = Math.max(0, minted - PICK_LIMIT);
    const older = myBoxes.filter((id) => id < lo).slice(0, PICK_LIMIT);
    void Promise.all([adapter.boxSummaries(lo, minted), Promise.all(older.map((id) => adapter.box(id).then(summaryOf)))])
      .then(([recent, mineOlder]) => live && setPool([...mineOlder, ...recent]))
      .catch(() => live && setPool([]));
    return () => {
      live = false;
    };
  }, [adapter, minted, myBoxes]);

  const mine = (id: number) => myBoxes.includes(id);
  // A box can take part while it is sealed; an entanglement also needs it unattached.
  const [yours, theirs] = useMemo(() => {
    const usable = (pool ?? []).filter((x) => x.status === "sealed" && (focus !== "entangle" || x.partner === null));
    return [usable.filter((x) => myBoxes.includes(x.tokenId)), usable.filter((x) => !myBoxes.includes(x.tokenId))];
  }, [pool, myBoxes, focus]);

  // First pair. Connected: one of the account's usable boxes on the left (the requested one
  // if it is), the newest usable box of another holder on the right. A requested box held
  // by someone else goes on the right. Not connected: any two boxes.
  useEffect(() => {
    if (picked || minted < 2) return;
    const asked = initial?.[0];
    if (!account) {
      const a = asked ?? 0;
      setPicked([a, a === 0 ? 1 : 0]);
      return;
    }
    if (!pool) return;
    const foreign = asked !== undefined && !myBoxes.includes(asked);
    const a = asked !== undefined && !foreign ? asked : (yours[0]?.tokenId ?? myBoxes[0] ?? 0);
    const b = foreign ? asked : (theirs.at(-1)?.tokenId ?? (pool.find((x) => x.tokenId !== a)?.tokenId ?? (a === 0 ? 1 : 0)));
    setPicked([a, b]);
  }, [picked, minted, initial, account, pool, yours, theirs, myBoxes]);

  const [a, b] = picked ?? [0, 1];

  const load = useCallback(async () => {
    if (!picked) return;
    try {
      const [boxA, boxB, standing] = await Promise.all([adapter.box(picked[0]), adapter.box(picked[1]), adapter.pair(picked[0], picked[1])]);
      setLoaded({ boxes: [boxA, boxB], standing });
    } catch {
      setLoaded(null);
    }
  }, [adapter, picked]);

  const { reset } = action;
  useEffect(() => {
    setLoaded(null);
    setOutcome(null);
    setPlaying(null);
    setNote(null);
    reset();
    void load();
  }, [load, reset]);

  useEffect(() => setTxs(contract ? recallTxs(contract, a, b) : []), [contract, a, b]);

  /** Passes the action's transactions to the pair's journal as they go through. */
  const logged = (o: ActionOptions): ActionOptions => ({
    ...o,
    onTx: (tx) => {
      o.onTx?.(tx);
      if (contract) setTxs(logTx(contract, a, b, tx));
    },
  });

  // Connected, each side only lists what can be used there: the account's boxes on the
  // left, other holders' on the right. The boxes on screen stay listed either way.
  const options = useMemo((): [number[], number[]] => {
    const sorted = (ids: Iterable<number>) => [...new Set(ids)].filter((id) => id < minted).sort((x, y) => x - y);
    if (!account) {
      const all = (pool ?? []).map((x) => x.tokenId);
      return [sorted([...all, a, b]), sorted([...all, a, b])];
    }
    return [sorted([...yours.map((x) => x.tokenId), a]), sorted([...theirs.map((x) => x.tokenId), b])];
  }, [account, pool, yours, theirs, minted, a, b]);
  // Only what was read for the boxes on screen: right after a pick, the last pair's boxes
  // (and their cats) are still in state, and must not be dressed onto the new ones.
  const current = loaded && loaded.boxes[0].tokenId === a && loaded.boxes[1].tokenId === b ? loaded : null;
  const boxes = current?.boxes ?? null;
  const standing = current?.standing ?? null;
  const [boxA, boxB] = boxes ?? [null, null];
  const catA = useMemo(() => (boxA?.revealed ? catFromRevealed(boxA.revealed) : null), [boxA]);
  const catB = useMemo(() => (boxB?.revealed ? catFromRevealed(boxB.revealed) : null), [boxB]);
  const entangled = !!boxA && boxA.partner === b;
  const bothSealed = boxA?.status === "sealed" && boxB?.status === "sealed";
  const busy = action.busy ?? playing;

  // What was just read for the two boxes on screen is fresher than the pool.
  useEffect(() => {
    if (!boxA || !boxB) return;
    const fresh = new Map([boxA, boxB].map((x) => [x.tokenId, summaryOf(x)]));
    setPool((p) => p && p.map((x) => fresh.get(x.tokenId) ?? x));
  }, [boxA, boxB]);

  const onDuelDone = useCallback(() => setPlaying(null), []);
  const onOpened = useCallback(() => setPlaying(null), []);

  const start = () => {
    sound.resume();
    setNote(null);
    setOutcome(null);
  };

  // --- duel. Facing another box, this account can put its own up for that box only, or take up
  // the one facing it when it is on the shelf for anyone (or for this box). One click runs every
  // step this account may take.
  const challenger = mine(a) ? a : mine(b) ? b : null;
  /** The box on screen that would take `d` up: the one it is reserved for, or the other one. */
  const takerOf = (d: DuelInfo) => (d.reserved ? d.tokenB! : d.tokenA === a ? b : a);
  /** Both boxes can be up at once: of their duels, the one this account can move on first. */
  const pickDuel = (list: DuelInfo[]): DuelInfo | null =>
    list.find((d) => d.status === "pending") ??
    list.find((d) => d.status === "posted" && sameAddress(d.challenger, account)) ??
    list.find((d) => d.status === "open" && mine(takerOf(d)) && (!sameAddress(d.challenger, account) || (mine(a) && mine(b)))) ??
    list[0] ??
    null;
  const duel = pickDuel(standing?.duels ?? []);
  const duelStep: "challenge" | "accept" | "waiting" | "prove" | "reveal" | null = !bothSealed
    ? null
    : !duel
      ? challenger !== null
        ? "challenge"
        : null
      : duel.status === "pending"
        ? "reveal"
        : duel.status === "posted"
          ? sameAddress(duel.challenger, account)
            ? "prove"
            : "waiting"
          : mine(takerOf(duel))
            ? "accept"
            : "waiting";

  const runDuel = async () => {
    start();
    const iHoldBoth = mine(a) && mine(b);
    setPlan([
      ...(duelStep === "challenge" ? [...SIGN_AND_MINE("track.post"), ...PROVE_HOLDING] : []),
      ...(duelStep === "prove" ? PROVE_HOLDING : []),
      ...(duelStep === "accept" || (duelStep === "challenge" && iHoldBoth) ? SIGN_AND_MINE("track.acceptDuel") : []),
      ...DECIDE,
    ]);
    const result = await action.run("duel", async (o0) => {
      const o = logged(o0);
      let d = pickDuel((await adapter.pair(a, b)).duels);
      if (!d) {
        const from = challenger!;
        d = await adapter.postDuel(from, { ...o, reservedFor: from === a ? b : a });
      } else if (d.status === "posted") {
        await adapter.finishDuel(d.duelId, o);
        d = pickDuel((await adapter.pair(a, b)).duels);
      }
      if (!d) return "waiting" as const;
      if (d.status === "pending") return adapter.finishDuel(d.duelId, o);
      if (d.status === "open" && mine(takerOf(d))) return adapter.acceptDuel(d.duelId, takerOf(d), o);
      return "waiting" as const;
    });
    if (result === undefined || result === "waiting" || result === null) {
      if (result === "waiting") setNote("pair.noteChallenge");
      if (result === null) setNote("pair.noteVoid");
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
    setPlan(SIGN_AND_MINE("track.withdraw"));
    await action.run("cancel", (o) => adapter.cancelDuel(duel.duelId, logged(o)));
    void load();
  };

  // --- entangle: propose, then the other holder accepts.
  const proposal = standing?.entangleProposal ?? null;
  const taken = !!boxA && !!boxB && !entangled && (boxA.partner !== null || boxB.partner !== null);
  const linkStep: "propose" | "accept" | "waiting" | null = !bothSealed || entangled || taken ? null : !proposal ? (challenger !== null ? "propose" : null) : mine(proposal.to) ? "accept" : "waiting";

  const runEntangle = async () => {
    start();
    setPlan([
      ...(linkStep === "propose" ? SIGN_AND_MINE("track.propose") : []),
      ...(linkStep === "accept" || (mine(a) && mine(b)) ? SIGN_AND_MINE("track.acceptLink") : []),
    ]);
    const linked = await action.run("entangle", async (o0) => {
      const o = logged(o0);
      let p = (await adapter.pair(a, b)).entangleProposal;
      if (!p) {
        const from = challenger!;
        const to = from === a ? b : a;
        await adapter.proposeEntangle(from, to, o);
        // The other holder may already have said yes (the mock's night shift does).
        if ((await adapter.box(from)).partner === to) return true;
        p = { from, to, proposer: account! };
      }
      if (!mine(p.to)) return false;
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
    setPlan(openable.status === "opening" ? OPEN_PLAN.slice(2) : OPEN_PLAN);
    const opened = await action.run("open", (o) => (openable.status === "opening" ? adapter.finishObserve(id, logged(o)) : adapter.observe(id, { ...logged(o), pay })));
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

      <section className={`slip${foldClass}`} aria-label={t("pair.aria")}>
        {foldButton}
        <div className="slip-head">
          <span>{t("pair.title")}</span>
          {entangled && <span className="tier tier-entangled">{t("pair.entangled")}</span>}
        </div>

        <div className="pair-pick">
          {([0, 1] as const).map((slot) => (
            <label key={slot}>
              {account ? t(slot === 0 ? "pair.yourSide" : "pair.theirSide") : slot === 0 ? t("pair.left") : t("pair.right")}
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
                {options[slot].map((id) => (
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
                  return t("pair.status", { holder: holderCopy(mine(x.tokenId)), state: status(x) }) + (x.wins ? t("pair.won", { n: x.wins }) : "");
                })()}
              </span>
              {account && pool && (slot === 0 ? yours : theirs).length === 0 && (
                <span className="fine problem">{t(slot === 0 ? (focus === "entangle" ? "pair.noneYoursFree" : "pair.noneYours") : focus === "entangle" ? "pair.noneTheirsFree" : "pair.noneTheirs")}</span>
              )}
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
        ) : !boxesKnown ? (
          <FindMine compact />
        ) : (
          opened.length < 2 && (
            <div className="actions">
              {offerDuel && (
                <button type="button" className="stamp-button" onClick={() => void runDuel()} disabled={!!busy || !duelStep || duelStep === "waiting"}>
                  {busy === "duel"
                    ? t("pair.fighting")
                    : duelStep === "accept"
                      ? t("pair.acceptDuel")
                      : duelStep === "reveal"
                        ? t("pair.reveal")
                        : duelStep === "prove"
                          ? t("pair.prove")
                          : duelStep === "waiting"
                            ? t("pair.challengeSent")
                            : t("pair.startDuel")}
                </button>
              )}
              {offerLink && (
                <button type="button" className={focus === "entangle" ? "stamp-button" : "plain-button"} onClick={() => void runEntangle()} disabled={!!busy || !linkStep || linkStep === "waiting"}>
                  {busy === "entangle" ? t("pair.linking") : entangled ? t("pair.entangled") : linkStep === "accept" ? t("pair.acceptLink") : linkStep === "waiting" ? t("pair.linkProposed") : t("pair.entangle")}
                </button>
              )}
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
            <>
              {plan && plan.length > 0 && <StepTracker key={action.busy} plan={plan} step={action.step} />}
              <p className="fine">{stepCopy(action.step)}</p>
              {action.step === "decrypting" && <p className="fine">{t("track.slow")}</p>}
            </>
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
          ) : offerDuel && duelStep === "waiting" && duel ? (
            <p className="fine">
              {t(duel.reserved ? "pair.waiting" : "pair.waitingShelf", { a: serial(duel.tokenA), b: serial(takerOf(duel)) })}
              {sameAddress(duel.challenger, account) && (
                <button type="button" className="link" onClick={() => void cancelDuel()}>
                  {t("pair.withdraw")}
                </button>
              )}
            </p>
          ) : offerDuel && duelStep === "accept" && duel ? (
            <p className="fine">{t(duel.reserved ? "pair.acceptExplain" : "pair.acceptShelf", { a: serial(duel.tokenA), b: serial(takerOf(duel)) })}</p>
          ) : offerDuel && duelStep === "prove" ? (
            <p className="fine">{t("pair.proveExplain")}</p>
          ) : offerDuel && duelStep === "reveal" ? (
            <p className="fine">{t("pair.revealExplain")}</p>
          ) : offerLink && linkStep === "accept" && proposal ? (
            <p className="fine">{t("pair.linkExplain", { from: serial(proposal.from), to: serial(proposal.to) })}</p>
          ) : entangled ? (
            <p className="fine">{t("pair.entangledExplain", { fee: fee(collection?.fees.observe ?? 0n, collection, pay) })}</p>
          ) : taken && offerLink ? (
            <p className="fine">{t("pair.taken")}</p>
          ) : challenger === null ? (
            <p className="fine">{t("pair.neither")}</p>
          ) : (
            <p className="fine">{t(focus === "entangle" ? "pair.entangleExplain" : focus === "duel" ? "pair.duelOnlyExplain" : "pair.duelExplain")}</p>
          )}
          {focus && !action.busy && (
            <p className="fine">
              <button type="button" className="link" onClick={() => setFocus(focus === "duel" ? "entangle" : "duel")}>
                {t(focus === "duel" ? "pair.ratherEntangle" : "pair.ratherDuel")}
              </button>
            </p>
          )}
        </div>

        <TxJournal txs={txs} locale={locale} />
      </section>
    </>
  );
}
