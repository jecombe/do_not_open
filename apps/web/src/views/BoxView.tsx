import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sameAddress, type ActionOptions, type BoxInfo, type Step, type TraitRoll } from "@dno/chain-adapter";
import { spec as gameSpec } from "@dno/game-spec";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { catFromRevealed, fee, holderCopy, stepCopy, traitCopy } from "../chain/copy";
import { useT, type AppKey } from "../i18n/app";
import { cap, catNames } from "../i18n/names";
import { BoxScene, type BoxSceneHandle, type InspectAngle } from "../scenes/Scenes";
import { Declaration } from "./Declaration";
import { Stage } from "./Stage";
import { StepTracker, type PlannedStep } from "./StepTracker";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  tokenId: number;
  onTokenChange: (tokenId: number) => void;
  onPair: (tokenId: number) => void;
  onShelf: () => void;
  onOverview: () => void;
}

const ANGLES: InspectAngle[] = ["front", "left", "back", "right", "above"];
const noop = () => {};
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

/** A note is stored as a message key, so it follows a language change. */
type Note = Extract<AppKey, "box.noteFed" | "box.noteAlive" | "box.noteNotAlive">;

export function BoxView({ quality, sound, tokenId, onTokenChange, onPair, onShelf, onOverview }: Props) {
  const { adapter, account, collection, refresh, connect } = useChain();
  const t = useT();
  const scene = useRef<BoxSceneHandle>(null);
  const action = useAction();
  const [loaded, setInfo] = useState<BoxInfo | null>(null);
  const [missingId, setMissingId] = useState<number | null>(null);
  const [felt, setFelt] = useState<TraitRoll | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [opening, setOpening] = useState(false);
  const [out, setOut] = useState(false);

  // Right after a step, and while a slow read lands late, the state can still hold the
  // previous box. Only what belongs to the box on screen counts: otherwise its cat opens here.
  const info = loaded?.tokenId === tokenId ? loaded : null;
  const missing = missingId === tokenId;
  const box = useMemo(() => buildBoxSpec(tokenId), [tokenId]);
  const minted = collection?.totalMinted ?? 0;
  const cat = useMemo(() => (info?.revealed ? catFromRevealed(info.revealed) : null), [info]);

  const load = useCallback(async () => {
    try {
      setInfo(await adapter.box(tokenId));
      setMissingId((m) => (m === tokenId ? null : m));
    } catch {
      setMissingId(tokenId);
    }
  }, [adapter, tokenId]);

  // The box shows the wait too: restless while a shake is pending, building up to the lid while an open is.
  useEffect(() => {
    const kind = action.busy === "open" ? "open" : action.busy === "shake" || action.busy === "alive" ? "peek" : null;
    scene.current?.wait(kind ? action.step : null, kind ?? "open");
  }, [action.busy, action.step]);

  const { reset } = action;
  useEffect(() => {
    setInfo(null);
    setFelt(null);
    setNote(null);
    setOpening(false);
    setOut(false);
    reset();
    void load();
  }, [load, reset]);

  const step = (delta: number) => minted > 0 && onTokenChange((tokenId + delta + minted) % minted);
  const isHolder = !!info && sameAddress(info.owner, account);
  const busy = action.busy ?? (opening ? "open" : null);
  const onOpened = useCallback(() => setOpening(false), []);
  const steps = (
    <div className="box-steps">
      <button type="button" className="plain-button overview" onClick={onOverview} disabled={!!busy}>
        {t("box.overview")}
      </button>
      <button type="button" className="plain-button" onClick={() => step(-1)} disabled={!!busy || minted < 2}>
        {t("box.prev")}
      </button>
      <button type="button" className="plain-button" onClick={() => step(1)} disabled={!!busy || minted < 2}>
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
    const result = await action.run("shake", (o) => (isHolder ? adapter.shake(tokenId, cue(o, "confirming", rattle)) : adapter.paidShake(tokenId, cue(o, "confirming", rattle))));
    if (!result) return;
    rattle();
    setFelt(result);
  };

  const feed = async () => {
    start();
    const done = await action.run("feed", async (o) => {
      await adapter.feed(tokenId, cue(o, "confirming", () => scene.current?.feed()));
      return true;
    });
    if (!done) return;
    setNote("box.noteFed");
    void load();
  };

  const checkAlive = async () => {
    start();
    const alive = await action.run("alive", (o) => (info?.aliveCheck === "pending" ? adapter.finishProveAlive(tokenId, o) : adapter.proveAlive(tokenId, o)));
    void load();
    if (alive === undefined) return;
    setNote(alive ? "box.noteAlive" : "box.noteNotAlive");
  };

  const open = async () => {
    start();
    const boxes = await action.run("open", (o) => (info?.status === "opening" ? adapter.finishObserve(tokenId, o) : adapter.observe(tokenId, o)));
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

  return (
    <>
      <Stage quality={quality}>
        <BoxScene ref={scene} tokenId={tokenId} opened={cat} quality={quality} sound={sound} onShakeDone={noop} onFed={noop} onOpened={onOpened} />
      </Stage>

      <section className="slip" aria-label={t("box.aria", { serial: box.serial })}>
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
              {t("box.openForGood", { serial: box.serial, holder: isHolder ? t("holder.youLower") : holderCopy(info!.owner, account) })}
              {cat.rarity.golden ? t("box.goldenFed") : info!.feeds > 0 ? t("box.fedNotEnough", { count: info!.feeds }) : ""}
              {info!.aliveCheck === "alive" ? t("box.vetBefore") : ""}
              {info!.partner !== null ? t("box.entangledWith", { serial: buildBoxSpec(info!.partner).serial }) : ""}
            </p>
            <div className="actions">
              <button type="button" className="stamp-button" onClick={() => inspect(true)}>
                {t("box.takeOut")}
              </button>
            </div>
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
                <dd>{info ? holderCopy(info.owner, account) : "…"}</dd>
              </div>
              <div>
                <dt>{t("box.fed")}</dt>
                <dd>{info ? `${info.feeds} ×` : "…"}</dd>
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

            <div className="actions">
              {!info ? (
                <button type="button" className="stamp-button" disabled>
                  {t("box.readingLabel")}
                </button>
              ) : !account ? (
                <button type="button" className="stamp-button" onClick={() => void connect()}>
                  {t("nav.connect")}
                </button>
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
                    </>
                  )}
                  <button type="button" className="plain-button" onClick={() => onPair(tokenId)} disabled={!!busy}>
                    {t("box.duelOrEntangle")}
                  </button>
                </>
              )}
            </div>

            <div className="felt" aria-live="polite">
              {action.error ? (
                <p className="fine problem">{action.error}</p>
              ) : action.busy ? (
                <>
                  {PLANS[action.busy] && (
                    <StepTracker
                      key={action.busy}
                      plan={(action.busy === "open" && info?.status === "opening") || (action.busy === "alive" && info?.aliveCheck === "pending") ? resumed(PLANS[action.busy]!) : PLANS[action.busy]!}
                      step={action.step}
                    />
                  )}
                  <p className="fine">{stepCopy(action.step, action.busy === "shake")}</p>
                  {action.step === "decrypting" && <p className="fine">{t("track.slow")}</p>}
                </>
              ) : felt ? (
                <>
                  <p className="felt-line">
                    {traitCopy(felt).trait}: <strong>{traitCopy(felt).variant}</strong>
                  </p>
                  <p className="fine">{t("box.shakeOnlyYou")}</p>
                </>
              ) : note ? (
                <p className="fine">{t(note)}</p>
              ) : !info ? null : !account ? (
                <p className="fine">{t("box.anyoneLook")}</p>
              ) : info.status === "opening" ? (
                <p className="fine">{t("box.stuckOpening")}</p>
              ) : isHolder ? (
                <p className="fine">{t("box.holderHint", { feed: fee(collection?.fees.feed ?? 0n, collection), open: fee(collection?.fees.observe ?? 0n, collection) })}</p>
              ) : (
                <p className="fine">
                  {t("box.strangerHint", { paid: fee(collection?.fees.paidShake ?? 0n, collection), share: HOLDER_SHARE, feed: fee(collection?.fees.feed ?? 0n, collection) })}
                </p>
              )}
            </div>
            {steps}
          </>
        )}
      </section>
    </>
  );
}
