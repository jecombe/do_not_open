import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionOptions, BoxInfo, BoxPantry, DuelInfo, PantryDay, Step, TraitRoll } from "@dno/chain-adapter";
import { spec as gameSpec } from "@dno/game-spec";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { VIEWS, type View } from "../Masthead";
import { catFromRevealed, fee, holderCopy, traitCopy } from "../chain/copy";
import { usePayment } from "../chain/payment";
import { recallFelt, rememberFelt, type Felt } from "../chain/feltCache";
import { useLocale } from "../i18n/locale";
import { useT, type AppKey } from "../i18n/app";
import { cap, catNames } from "../i18n/names";
import { BoxScene, type BoxSceneHandle, type InspectAngle } from "../scenes/Scenes";
import { Declaration } from "./Declaration";
import { PayWith } from "./PayWith";
import { ShareBox } from "./ShareBox";
import { Stage } from "./Stage";
import { type PlannedStep } from "./StepTracker";
import { TxPending } from "./TxPending";
import { FindMine } from "./FindMine";
import { parseAmount } from "./PantryView";
import { useFold } from "./useFold";
import { ProblemNote } from "./ProblemNote";
import { boxTags } from "../chain/tags";
import { Hint } from "./Hint";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  tokenId: number;
  onTokenChange: (tokenId: number) => void;
  onPair: (tokenId: number) => void;
  onShelf: () => void;
  /** To the croquettes tab, where the boxes' bags and purrs are collected. */
  onPantry: () => void;
  /** The view the box was opened from, and the way back to it. */
  backTo: Exclude<View, "box">;
  onBack: () => void;
}

/** What the slip says while each action runs. */
const WORKING: Record<string, AppKey> = {
  open: "box.opening",
  shake: "box.shaking",
  feed: "box.feeding",
  alive: "box.checking",
  give: "box.giving",
  serve: "box.serving",
  weigh: "box.weighing",
};
const ANGLES: InspectAngle[] = ["front", "left", "back", "right", "above"];
const noop = () => {};
/** Decoys sent with a box given away, when the holder asks for them. */
const DECOYS = 3;
/** What each slow action goes through, in order, as the tracker lists it. */
const PLANS: Record<string, PlannedStep[]> = {
  open: [
    { step: "wallet", label: "track.sign" },
    { step: "confirming", label: "track.chain" },
    { step: "decrypting", label: "track.decryptPublic" },
    { step: "proving", label: "track.proof" },
  ],
  alive: [
    { step: "wallet", label: "track.sign" },
    { step: "confirming", label: "track.chain" },
    { step: "decrypting", label: "track.decryptPublic" },
    { step: "proving", label: "track.proof" },
  ],
  shake: [
    { step: "wallet", label: "track.sign" },
    { step: "confirming", label: "track.chain" },
    { step: "wallet", label: "track.permit" },
    { step: "decrypting", label: "track.decryptPrivate" },
  ],
  feed: [
    { step: "wallet", label: "track.sign" },
    { step: "confirming", label: "track.chain" },
  ],
  serve: [
    { step: "encrypting", label: "track.encrypt" },
    { step: "wallet", label: "track.sign" },
    { step: "confirming", label: "track.chain" },
  ],
  weigh: [
    { step: "wallet", label: "track.sign" },
    { step: "confirming", label: "track.chain" },
    { step: "decrypting", label: "track.decryptPublic" },
    { step: "proving", label: "track.proof" },
  ],
  today: [
    { step: "wallet", label: "track.permit" },
    { step: "decrypting", label: "track.decryptPrivate" },
  ],
};
/** Finishing a half-done open or check starts at the decryption. */
const resumed = (plan: PlannedStep[]) => plan.slice(2);

const HOLDER_SHARE = Number(gameSpec.mechanics.paidShake?.holderShareBps ?? 7000) / 100;

/** Runs `then` the first time an action reaches `at`: the moment the scene should react. */
const cue = (opts: ActionOptions, at: Step, then: () => void): ActionOptions => {
  let fired = false;
  return {
    onStep: (step) => {
      opts.onStep?.(step);
      if (step === at && !fired) {
        fired = true;
        then();
      }
    },
  };
};

/** "3 hours ago", in the reader's language. */
const ago = (at: number, locale: string) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return minutes < 60 ? rtf.format(-minutes, "minute") : rtf.format(-Math.round(minutes / 60), "hour");
};

/** A note is stored as a message key, so it follows a language change. */
type Note = Extract<AppKey, "box.noteFed" | "box.noteAlive" | "box.noteNotAlive" | "box.noteServed" | "box.noteWeighed" | "box.noteSent">;

const { meal } = gameSpec.economy;
const DAILY_CAP = BigInt(meal.maxEatenPerDay);

export function BoxView({ quality, sound, tokenId, onTokenChange, onPair, onShelf, onPantry, backTo, onBack }: Props) {
  const { adapter, account, collection, myBoxes, boxesKnown, refresh, connect } = useChain();
  const pay = usePayment();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const scene = useRef<BoxSceneHandle>(null);
  const action = useAction();
  const [loaded, setInfo] = useState<BoxInfo | null>(null);
  const [pantry, setPantry] = useState<{ tokenId: number; at: BoxPantry } | null>(null);
  const [duels, setDuels] = useState<{ tokenId: number; list: DuelInfo[] } | null>(null);
  const [serving, setServing] = useState(false);
  const [croq, setCroq] = useState("");
  // What the holder fed this cat today, decrypted for them: the input stops at what is left.
  const [day, setDay] = useState<{ tokenId: number; value: PantryDay } | null>(null);
  const [giving, setGiving] = useState(false);
  const [giveTo, setGiveTo] = useState("");
  const [decoys, setDecoys] = useState(false);
  const [missingId, setMissingId] = useState<number | null>(null);
  const [felt, setFelt] = useState<TraitRoll | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [opening, setOpening] = useState(false);
  const [out, setOut] = useState(false);
  // Shakes answered in the last 24 hours, kept in this browser for whoever shook.
  const [remembered, setRemembered] = useState<Felt[]>([]);
  const locale = useLocale();

  // Right after a step, and while a slow read lands late, the state can still hold the
  // previous box. Only what belongs to the box on screen counts: otherwise its cat opens here.
  const info = loaded?.tokenId === tokenId ? loaded : null;
  const missing = missingId === tokenId;
  const box = useMemo(() => buildBoxSpec(tokenId), [tokenId]);
  const minted = collection?.tokenCount ?? 0;

  const load = useCallback(async () => {
    try {
      setInfo(await adapter.box(tokenId));
      setMissingId((m) => (m === tokenId ? null : m));
    } catch {
      setMissingId(tokenId);
      return;
    }
    // A duel it is up for, or in: a tag on the box. Without the list the box simply goes untagged.
    adapter.duels({ tokenIds: [tokenId], open: true }).then(
      (list) => setDuels({ tokenId, list }),
      () => setDuels(null),
    );
    // The cat's meals and weigh-in live next door, in the Pantry. Without it the box still works.
    adapter.boxPantry(tokenId).then(
      (at) => setPantry({ tokenId, at }),
      () => setPantry(null),
    );
  }, [adapter, tokenId]);
  const kitchen = pantry?.tokenId === tokenId ? pantry.at : null;
  // A welcome bag or a purr waits for this box in the Pantry.
  const claimable = !!kitchen && (!kitchen.welcomed || kitchen.nextClaimAt <= Date.now() / 1000);
  const collectLine = (
    <p className="fine">
      {t(claimable ? "box.claimWaiting" : "box.croquettesFrom")}{" "}
      <button type="button" className="link" onClick={onPantry}>
        {t("box.goCollect")}
      </button>
    </p>
  );
  const tags = useMemo(
    () => (info ? boxTags(info, duels?.tokenId === tokenId ? duels.list : []) : []),
    // `t` changes with the language the tags are worded in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info, duels, tokenId, t],
  );
  const weighIn = kitchen?.weighIn ?? null;
  const cat = useMemo(() => (info?.revealed ? catFromRevealed(info.revealed, weighIn) : null), [info, weighIn]);
  const today = day?.tokenId === tokenId ? day.value : null;
  const fullToday = !!today && today.meals >= meal.mealsPerDay;
  const leftToday = today === null ? null : DAILY_CAP - today.eaten;

  // The box shows the wait too: restless for a shake, a heartbeat for the vet, building up to the lid for an open.
  useEffect(() => {
    const kind = action.busy === "open" ? "open" : action.busy === "shake" ? "peek" : action.busy === "alive" ? "vet" : null;
    // Encrypting happens before anything is sent: the box has nothing to show yet.
    scene.current?.wait(kind && action.step !== "encrypting" ? action.step : null, kind ?? "open");
  }, [action.busy, action.step]);

  const contract = collection?.address ?? null;
  useEffect(() => {
    setRemembered(contract && account ? recallFelt(contract, account, tokenId) : []);
  }, [contract, account, tokenId]);

  const { reset } = action;
  useEffect(() => {
    setInfo(null);
    setFelt(null);
    setNote(null);
    setOpening(false);
    setOut(false);
    setServing(false);
    setCroq("");
    setDay(null);
    setGiving(false);
    setGiveTo("");
    reset();
    void load();
  }, [load, reset]);

  const isHolder = myBoxes.includes(tokenId);
  const busy = action.busy ?? (opening ? "open" : null);
  const onOpened = useCallback(() => setOpening(false), []);
  // Previous and next go round the player's own boxes only, in order.
  const mine = useMemo(() => [...myBoxes].sort((a, b) => a - b), [myBoxes]);
  const step = (delta: number) => {
    const at = mine.indexOf(tokenId);
    if (at >= 0) onTokenChange(mine[(at + delta + mine.length) % mine.length]!);
  };
  const steps = isHolder && mine.length > 1 && (
    <div className="box-steps">
      <button type="button" className="plain-button" onClick={() => step(-1)} disabled={!!busy}>
        {t("box.prev")}
      </button>
      <button type="button" className="plain-button" onClick={() => step(1)} disabled={!!busy}>
        {t("box.next")}
      </button>
    </div>
  );

  const start = () => {
    sound.resume();
    setFelt(null);
    setNote(null);
  };

  const shake = async () => {
    start();
    const rattle = () => scene.current?.shake();
    const result = await action.run("shake", (o) => (isHolder ? adapter.shake(tokenId, cue(o, "confirming", rattle)) : adapter.paidShake(tokenId, { ...cue(o, "confirming", rattle), pay })));
    if (!result) return;
    rattle();
    setFelt(result);
    if (contract && account) setRemembered(rememberFelt(contract, account, tokenId, result));
  };

  const feed = async () => {
    start();
    const done = await action.run("feed", async (o) => {
      await adapter.feed(tokenId, { ...cue(o, "confirming", () => scene.current?.pet()), pay });
      return true;
    });
    if (!done) return;
    setNote("box.noteFed");
    void load();
  };

  const croqAmount = parseAmount(croq, 0);
  const tooMuch = !!croqAmount && leftToday !== null && croqAmount > leftToday;

  /** Opens the bowl form, and reads what the cat already ate today if it ate at all. */
  const toggleServing = async () => {
    if (serving) {
      setServing(false);
      return;
    }
    setServing(true);
    if (!kitchen || today) return;
    const value = await action.run("today", (o) => adapter.pantryDay(tokenId, o));
    if (value !== undefined) setDay({ tokenId, value });
  };

  /** Gives the box to another address. Moves it only if it is yours, which it is here. */
  const give = async () => {
    const to = giveTo.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return;
    start();
    const done = await action.run("give", async (o) => {
      await adapter.sendBox(tokenId, to, { ...o, decoys: decoys ? DECOYS : 0 });
      return true;
    });
    if (!done) return;
    setGiving(false);
    setGiveTo("");
    setNote("box.noteSent");
    await refresh();
  };

  const serve = async () => {
    if (!croqAmount || tooMuch) return;
    start();
    const done = await action.run("serve", async (o) => {
      await adapter.feedCroquettes(tokenId, croqAmount, cue(o, "confirming", () => scene.current?.feed()));
      return true;
    });
    if (!done) return;
    setServing(false);
    setCroq("");
    // A meal can be cut down, or move nothing: read the day again rather than guess.
    setDay(null);
    setNote("box.noteServed");
    void load();
  };

  const weigh = async () => {
    start();
    const result = await action.run("weigh", (o) => adapter.weigh(tokenId, o));
    if (!result) {
      void load();
      return;
    }
    if (kitchen) setPantry({ tokenId, at: { ...kitchen, weighing: "done", weighIn: result } });
    setNote("box.noteWeighed");
  };

  const checkAlive = async () => {
    start();
    const alive = await action.run("alive", (o) => (info?.aliveCheck === "pending" ? adapter.finishProveAlive(tokenId, o) : adapter.proveAlive(tokenId, o)));
    void load();
    if (alive === undefined) return;
    scene.current?.certify(alive);
    setNote(alive ? "box.noteAlive" : "box.noteNotAlive");
  };

  const open = async () => {
    start();
    const boxes = await action.run("open", (o) => (info?.status === "opening" ? adapter.finishObserve(tokenId, o) : adapter.observe(tokenId, { ...o, pay })));
    const mine = boxes?.find((b) => b.tokenId === tokenId);
    if (!mine?.revealed) {
      void load();
      return;
    }
    if (scene.current) {
      setOpening(true);
      scene.current.open(catFromRevealed(mine.revealed));
    }
    setInfo(mine);
    void refresh();
  };

  const inspect = (on: boolean) => {
    sound.resume();
    setOut(on);
    scene.current?.inspect(on);
  };

  const revealed = cat && !opening;
  const names = cat ? catNames(cat) : null;
  const share = info && (
    <ShareBox
      key={`${tokenId}-${revealed ? cat.seed : "sealed"}`}
      tokenId={tokenId}
      serial={box.serial}
      cat={revealed ? cat : null}
      mine={isHolder}
      shakeFee={fee(collection?.fees.paidShake ?? 0n, collection, pay)}
      holderShare={HOLDER_SHARE}
    />
  );

  return (
    <>
      <Stage quality={quality}>
        <BoxScene
          ref={scene}
          tokenId={tokenId}
          opened={cat}
          vet={info?.aliveCheck === "alive" || info?.aliveCheck === "notAlive" ? info.aliveCheck : null}
          tags={tags}
          quality={quality}
          sound={sound}
          onShakeDone={noop}
          onFed={noop}
          onOpened={onOpened}
        />
      </Stage>

      <section className={`slip${foldClass}`} aria-label={t("box.aria", { serial: box.serial })}>
        {foldButton}
        <button type="button" className="link back-link keep" onClick={onBack} disabled={!!busy}>
          {t("box.backTo", { view: t(VIEWS.find((v) => v.key === backTo)!.label) })}
        </button>
        <TxPending
          busy={action.busy}
          step={action.step}
          title={t(WORKING[action.busy ?? ""] ?? "tx.working")}
          secret={action.busy === "shake" || action.busy === "today"}
          plan={
            !action.busy || !PLANS[action.busy]
              ? null
              : (action.busy === "open" && info?.status === "opening") || (action.busy === "alive" && info?.aliveCheck === "pending") || (action.busy === "weigh" && kitchen?.weighing === "pending")
                ? resumed(PLANS[action.busy]!)
                : PLANS[action.busy]!
          }
        >
          {missing ? (
            <>
              <div className="slip-head">
                <span>{t("box.consignment")}</span>
              </div>
              <p className="serial">{box.serial}</p>
              <p className="state-note">{minted === 0 ? t("box.noneMinted") : t("box.notMinted")}</p>
              <button type="button" className="stamp-button" onClick={minted > 0 ? () => onTokenChange(0) : onShelf}>
                {minted > 0 ? t("box.backFirst") : t("box.goShelf")}
              </button>
            </>
          ) : revealed && out ? (
            <>
              <div className="slip-head">
                <span>{t("box.inspection", { serial: box.serial })}</span>
                <span className={`tier tier-${cat.rarity.tier}`}>{names!.tier}</span>
              </div>
              <p className="state-note">{cap(t("box.catLine", { breed: names!.breed.toLowerCase(), mood: names!.mood.toLowerCase(), state: names!.state.toLowerCase() }))}</p>
              <div className="picker" role="group" aria-label={t("box.lookFrom")}>
                {ANGLES.map((a) => (
                  <button type="button" key={a} onClick={() => scene.current?.lookFrom(a)}>
                    {t(`angle.${a}`)}
                  </button>
                ))}
              </div>
              <p className="fine after-table">{t("box.dragHint")}</p>
              <button type="button" className="stamp-button" onClick={() => inspect(false)}>
                {t("box.putBack")}
              </button>
            </>
          ) : revealed ? (
            <Declaration cat={cat}>
              <p className="fine after-table">
                {t("box.openForGood", { serial: box.serial })}
                {isHolder ? t("box.openYours") : ""}
                {cat.rarity.golden ? t("box.goldenFed") : ""}
                {info!.aliveCheck === "alive" ? t("box.vetBefore") : ""}
                {info!.partner !== null ? t("box.entangledWith", { serial: buildBoxSpec(info!.partner).serial }) : ""}
              </p>
              {kitchen && !weighIn && (
                <p className="fine">{t("box.weighPromptHidden")}</p>
              )}
              <div className="actions">
                <button type="button" className="stamp-button" onClick={() => inspect(true)}>
                  {t("box.takeOut")}
                </button>
                {kitchen && !weighIn && account && (
                  <button type="button" className="plain-button" onClick={() => void weigh()} disabled={!!busy}>
                    {busy === "weigh" ? t("box.weighing") : kitchen.weighing === "pending" ? t("box.finishWeigh") : t("box.weigh")}
                  </button>
                )}
              </div>
              {action.error ? (
                <ProblemNote problem={action.error} />
              ) : note === "box.noteWeighed" ? (
                <p className="fine">{t(note)}</p>
              ) : null}
              {share}
              {steps}
            </Declaration>
          ) : (
            <>
              <div className="slip-head">
                <span>{t("box.consignment")}</span>
              </div>
              <p className="serial">{box.serial}</p>
              <dl className="fields">
                <div>
                  <dt>{t("box.dock")}</dt>
                  <dd>{box.dock}</dd>
                </div>
                <div>
                  <dt>{t("box.holder")}</dt>
                  <dd>{info ? holderCopy(isHolder) : "…"}</dd>
                </div>
              </dl>

              {info && (info.aliveCheck === "alive" || info.aliveCheck === "notAlive" || info.partner !== null || info.wins > 0 || info.publicTraits.length > 0) && (
                <ul className="marks">
                  {info.aliveCheck === "alive" && <li className="mark-good">{t("box.markVet")}</li>}
                  {info.aliveCheck === "notAlive" && <li>{t("box.markNotAlive")}</li>}
                  {info.partner !== null && <li className="mark-entangled">{t("box.markEntangled", { serial: buildBoxSpec(info.partner).serial })}</li>}
                  {info.wins > 0 && <li>{t("box.markWins", { count: info.wins })}</li>}
                  {info.publicTraits.map((r) => {
                    const c = traitCopy(r);
                    return <li key={r.traitIndex}>{t("box.markLost", { trait: c.trait.toLowerCase(), variant: c.variant })}</li>;
                  })}
                </ul>
              )}

              {remembered.length > 0 && (
                <div className="felt-log">
                  <p className="felt-log-head">{t("box.feltLog")}</p>
                  <ul>
                    {remembered.map((f) => {
                      const c = traitCopy(f);
                      return (
                        <li key={f.traitIndex}>
                          {c.trait}: <strong>{c.variant}</strong>
                          <span>{ago(f.at, locale)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="actions">
                {!info ? (
                  <button type="button" className="stamp-button" disabled>
                    {t("box.readingLabel")}
                  </button>
                ) : !account ? (
                  <button type="button" className="stamp-button" onClick={() => void connect()}>
                    {t("nav.connect")}
                  </button>
                ) : !boxesKnown ? (
                  <FindMine compact />
                ) : info.status === "opening" ? (
                  <button type="button" className="stamp-button" onClick={() => void open()} disabled={!!busy}>
                    {busy === "open" ? t("box.opening") : t("box.finishOpening")}
                  </button>
                ) : (
                  <>
                    <button type="button" className="stamp-button" onClick={() => void shake()} disabled={!!busy}>
                      {busy === "shake" ? t("box.shaking") : isHolder ? t("box.shake") : t("box.payShake")}
                    </button>
                    <button type="button" className="plain-button" onClick={() => void feed()} disabled={!!busy}>
                      {busy === "feed" ? t("box.feeding") : t("box.feed")}
                    </button>
                    {kitchen && isHolder && (
                      <button type="button" className="plain-button" onClick={() => void toggleServing()} disabled={!!busy || fullToday} aria-expanded={serving}>
                        {busy === "serve" ? t("box.serving") : fullToday ? t("box.fullToday") : t("box.serve")}
                      </button>
                    )}
                    {isHolder && (
                      <>
                        <button type="button" className="plain-button" onClick={() => void open()} disabled={!!busy}>
                          {busy === "open" ? t("box.opening") : t("box.open")}
                        </button>
                        {(info.aliveCheck === "none" || info.aliveCheck === "pending") && (
                          <button type="button" className="plain-button" onClick={() => void checkAlive()} disabled={!!busy}>
                            {busy === "alive" ? t("box.checking") : info.aliveCheck === "pending" ? t("box.finishCheck") : t("box.isAlive")}
                          </button>
                        )}
                        <button type="button" className="plain-button" onClick={() => setGiving((g) => !g)} disabled={!!busy} aria-expanded={giving}>
                          {busy === "give" ? t("box.giving") : t("box.give")}
                        </button>
                      </>
                    )}
                    <button type="button" className="plain-button" onClick={() => onPair(tokenId)} disabled={!!busy}>
                      {t("box.duelOrEntangle")}
                    </button>
                  </>
                )}
              </div>

              {account && boxesKnown && info?.status === "sealed" && <PayWith busy={busy} need={(isHolder ? collection?.fees.observe : collection?.fees.paidShake) ?? 0n} compact />}

              {giving && isHolder && (
                <form
                  className="find pantry-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void give();
                  }}
                >
                  <label htmlFor="give-to">{t("box.giveTo")}</label>
                  <input id="give-to" autoComplete="off" spellCheck={false} value={giveTo} onChange={(e) => setGiveTo(e.target.value)} placeholder="0x…" disabled={!!busy} />
                  <button type="submit" className="plain-button" disabled={!!busy || !/^0x[0-9a-fA-F]{40}$/.test(giveTo.trim())}>
                    {t("box.giveGo")}
                  </button>
                  <label className="check">
                    <input type="checkbox" checked={decoys} onChange={(e) => setDecoys(e.target.checked)} disabled={!!busy} />
                    {t("box.giveDecoys", { n: DECOYS })}
                  </label>
                </form>
              )}

              {serving && info?.status === "sealed" && isHolder && !fullToday && (
                <form
                  className="find pantry-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void serve();
                  }}
                >
                  <label htmlFor="serve-amount">{t("box.serveLabel")}</label>
                  <input id="serve-amount" inputMode="numeric" autoComplete="off" value={croq} onChange={(e) => setCroq(e.target.value)} placeholder={String(leftToday ?? DAILY_CAP)} disabled={!!busy} />
                  <button type="submit" className="plain-button" disabled={!!busy || !croqAmount || tooMuch}>
                    {t("box.serveGo")}
                  </button>
                </form>
              )}

              <div className="felt" aria-live="polite">
                {action.error ? (
                  <ProblemNote problem={action.error} />
                ) : felt ? (
                  <>
                    <p className="felt-line">
                      {traitCopy(felt).trait}: <strong>{traitCopy(felt).variant}</strong>
                    </p>
                    <p className="fine">{t("box.shakeOnlyYou")}</p>
                  </>
                ) : serving ? (
                  <>
                    <p className="fine">
                      {today === null
                        ? t("box.todayUnread")
                        : t("box.today", { meals: today.meals, max: meal.mealsPerDay, eaten: String(today.eaten), cap: meal.maxEatenPerDay })}
                      {tooMuch ? ` ${t("box.tooMuchToday", { left: String(leftToday) })}` : ""}
                      <Hint label={t("box.serveHelp")}>
                        {t("box.serveHint", { treasury: meal.treasuryBps / 100, burn: meal.burnBps / 100, reserve: (10_000 - meal.treasuryBps - meal.burnBps) / 100 })}
                      </Hint>
                    </p>
                    {collectLine}
                  </>
                ) : giving ? (
                  <p className="fine">
                    {t("box.giveHint", { serial: box.serial })}
                    {decoys ? ` ${t("box.giveDecoysHint", { n: DECOYS })}` : ""}
                  </p>
                ) : note ? (
                  <p className="fine">{t(note)}</p>
                ) : !info ? null : !account ? (
                  <p className="fine">{t("box.anyoneLook")}</p>
                ) : info.status === "opening" ? (
                  <p className="fine">{t("box.stuckOpening")}</p>
                ) : isHolder ? (
                  <>
                    <p className="fine">{t("box.holderHint", { feed: fee(collection?.fees.feed ?? 0n, collection, pay), open: fee(collection?.fees.observe ?? 0n, collection, pay) })}</p>
                    {claimable && collectLine}
                  </>
                ) : (
                  <p className="fine">
                    {t("box.strangerHint", { paid: fee(collection?.fees.paidShake ?? 0n, collection, pay), share: HOLDER_SHARE, feed: fee(collection?.fees.feed ?? 0n, collection, pay) })}
                  </p>
                )}
              </div>
              {share}
              {steps}
            </>
          )}
        </TxPending>
      </section>
    </>
  );
}
