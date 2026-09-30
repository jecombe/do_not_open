import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sameAddress, type ActionOptions, type BoxInfo, type Step, type TraitRoll } from "@dno/chain-adapter";
import { spec as gameSpec } from "@dno/game-spec";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { catFromRevealed, fee, holderCopy, stepCopy, traitCopy } from "../chain/copy";
import { BoxScene, type BoxSceneHandle, type InspectAngle } from "../scenes/Scenes";
import { Declaration } from "./Declaration";
import { Stage } from "./Stage";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  tokenId: number;
  onTokenChange: (tokenId: number) => void;
  onPair: (tokenId: number) => void;
  onShelf: () => void;
}

const ANGLES: InspectAngle[] = ["front", "left", "back", "right", "above"];
const noop = () => {};
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

export function BoxView({ quality, sound, tokenId, onTokenChange, onPair, onShelf }: Props) {
  const { adapter, account, collection, refresh, connect } = useChain();
  const scene = useRef<BoxSceneHandle>(null);
  const action = useAction();
  const [info, setInfo] = useState<BoxInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [felt, setFelt] = useState<TraitRoll | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [out, setOut] = useState(false);

  const box = useMemo(() => buildBoxSpec(tokenId), [tokenId]);
  const minted = collection?.totalMinted ?? 0;
  const cat = useMemo(() => (info?.revealed ? catFromRevealed(info.revealed) : null), [info]);

  const load = useCallback(async () => {
    try {
      setInfo(await adapter.box(tokenId));
      setMissing(false);
    } catch {
      setInfo(null);
      setMissing(true);
    }
  }, [adapter, tokenId]);

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
    setNote("Fed. How much affection that earned is encrypted; you find out when the box is opened.");
    void load();
  };

  const checkAlive = async () => {
    start();
    const alive = await action.run("alive", (o) => (info?.aliveCheck === "pending" ? adapter.finishProveAlive(tokenId, o) : adapter.proveAlive(tokenId, o)));
    void load();
    if (alive === undefined) return;
    setNote(
      alive
        ? "It is alive. The box now carries a Vet Certified mark that anyone can see."
        : "Not alive. Asleep, ghost or quantum: the check does not say which. Anyone can see this answer.",
    );
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

  return (
    <>
      <Stage quality={quality}>
        <BoxScene ref={scene} tokenId={tokenId} opened={cat} quality={quality} sound={sound} onShakeDone={noop} onFed={noop} onOpened={onOpened} />
      </Stage>

      <section className="slip" aria-label={`Box ${box.serial}`}>
        {missing ? (
          <>
            <div className="slip-head">
              <span>Consignment</span>
            </div>
            <p className="serial">{box.serial}</p>
            <p className="state-note">{minted === 0 ? "No box has been minted yet." : "This box has not been minted yet."}</p>
            <button type="button" className="stamp-button" onClick={minted > 0 ? () => onTokenChange(0) : onShelf}>
              {minted > 0 ? "Back to the first box" : "Go to your shelf"}
            </button>
          </>
        ) : revealed && out ? (
          <>
            <div className="slip-head">
              <span>Inspection, {box.serial}</span>
              <span className={`tier tier-${cat.rarity.tier}`}>{cat.rarity.tierName}</span>
            </div>
            <p className="state-note">
              {cat.traits.breed.name}, {cat.traits.mood.name.toLowerCase()}, {cat.state}.
            </p>
            <div className="picker" role="group" aria-label="Look from">
              {ANGLES.map((a) => (
                <button type="button" key={a} onClick={() => scene.current?.lookFrom(a)}>
                  {a[0]!.toUpperCase() + a.slice(1)}
                </button>
              ))}
            </div>
            <p className="fine after-table">Drag to walk around it. Scroll or pinch to get closer.</p>
            <button type="button" className="stamp-button" onClick={() => inspect(false)}>
              Put it back
            </button>
          </>
        ) : revealed ? (
          <Declaration cat={cat}>
            <p className="fine after-table">
              {box.serial} is open for good. Held by {isHolder ? "you" : holderCopy(info!.owner, account)}.
              {cat.rarity.golden ? " It was fed enough to come out in gold." : info!.feeds > 0 ? ` Fed ${info!.feeds} time${info!.feeds > 1 ? "s" : ""}, not quite enough for gold.` : ""}
              {info!.aliveCheck === "alive" ? " Vet Certified before opening." : ""}
              {info!.partner !== null ? ` Entangled with ${buildBoxSpec(info!.partner).serial}.` : ""}
            </p>
            <div className="actions">
              <button type="button" className="stamp-button" onClick={() => inspect(true)}>
                Take the cat out
              </button>
              <button type="button" className="plain-button" onClick={() => step(-1)}>
                Previous box
              </button>
              <button type="button" className="plain-button" onClick={() => step(1)}>
                Next box
              </button>
            </div>
          </Declaration>
        ) : (
          <>
            <div className="slip-head">
              <span>Consignment</span>
              <div className="stepper">
                <button type="button" onClick={() => step(-1)} aria-label="Previous box" disabled={!!busy || minted < 2}>
                  ‹
                </button>
                <button type="button" onClick={() => step(1)} aria-label="Next box" disabled={!!busy || minted < 2}>
                  ›
                </button>
              </div>
            </div>
            <p className="serial">{box.serial}</p>
            <dl className="fields">
              <div>
                <dt>Dock</dt>
                <dd>{box.dock}</dd>
              </div>
              <div>
                <dt>Holder</dt>
                <dd>{info ? holderCopy(info.owner, account) : "…"}</dd>
              </div>
              <div>
                <dt>Fed</dt>
                <dd>{info ? `${info.feeds} ×` : "…"}</dd>
              </div>
            </dl>

            {info && (info.aliveCheck === "alive" || info.aliveCheck === "notAlive" || info.partner !== null || info.wins > 0 || info.publicTraits.length > 0) && (
              <ul className="marks">
                {info.aliveCheck === "alive" && <li className="mark-good">Vet Certified: alive</li>}
                {info.aliveCheck === "notAlive" && <li>Checked: not alive</li>}
                {info.partner !== null && <li className="mark-entangled">Entangled with {buildBoxSpec(info.partner).serial}</li>}
                {info.wins > 0 && <li>{info.wins} duel{info.wins > 1 ? "s" : ""} won</li>}
                {info.publicTraits.map((t) => {
                  const c = traitCopy(t);
                  return (
                    <li key={t.traitIndex}>
                      Lost a duel, had to show {c.trait.toLowerCase()}: {c.variant}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="actions">
              {!info ? (
                <button type="button" className="stamp-button" disabled>
                  Reading the label…
                </button>
              ) : !account ? (
                <button type="button" className="stamp-button" onClick={() => void connect()}>
                  Connect wallet
                </button>
              ) : info.status === "opening" ? (
                <button type="button" className="stamp-button" onClick={() => void open()} disabled={!!busy}>
                  {busy === "open" ? "Opening…" : "Finish opening"}
                </button>
              ) : (
                <>
                  <button type="button" className="stamp-button" onClick={() => void shake()} disabled={!!busy}>
                    {busy === "shake" ? "Shaking…" : isHolder ? "Shake the box" : "Pay to shake"}
                  </button>
                  <button type="button" className="plain-button" onClick={() => void feed()} disabled={!!busy}>
                    {busy === "feed" ? "Feeding…" : "Feed it"}
                  </button>
                  {isHolder && (
                    <>
                      <button type="button" className="plain-button" onClick={() => void open()} disabled={!!busy}>
                        {busy === "open" ? "Opening…" : "Open the box"}
                      </button>
                      {(info.aliveCheck === "none" || info.aliveCheck === "pending") && (
                        <button type="button" className="plain-button" onClick={() => void checkAlive()} disabled={!!busy}>
                          {busy === "alive" ? "Checking…" : info.aliveCheck === "pending" ? "Finish the check" : "Is it alive?"}
                        </button>
                      )}
                    </>
                  )}
                  <button type="button" className="plain-button" onClick={() => onPair(tokenId)} disabled={!!busy}>
                    Duel or entangle
                  </button>
                </>
              )}
            </div>

            <div className="felt" aria-live="polite">
              {action.error ? (
                <p className="fine problem">{action.error}</p>
              ) : action.busy ? (
                <p className="fine">{stepCopy(action.step, action.busy === "shake")}</p>
              ) : felt ? (
                <>
                  <p className="felt-line">
                    {traitCopy(felt).trait}: <strong>{traitCopy(felt).variant}</strong>
                  </p>
                  <p className="fine">Only you can read a shake. Whether the cat is alive stays sealed.</p>
                </>
              ) : note ? (
                <p className="fine">{note}</p>
              ) : !info ? null : !account ? (
                <p className="fine">Anyone can look at a sealed box. To shake, feed or open one, connect a wallet.</p>
              ) : info.status === "opening" ? (
                <p className="fine">The holder started opening this box and the last step never went through. Anyone can finish it.</p>
              ) : isHolder ? (
                <p className="fine">
                  Shaking is free and tells you one trait. Feeding costs {fee(collection?.fees.feed ?? 0n, collection)}, opening {fee(collection?.fees.observe ?? 0n, collection)}. Opening cannot be undone.
                </p>
              ) : (
                <p className="fine">
                  Not your box. For {fee(collection?.fees.paidShake ?? 0n, collection)} you can shake it and read one trait; its holder learns nothing and keeps {HOLDER_SHARE}%. Feeding costs {fee(collection?.fees.feed ?? 0n, collection)}.
                </p>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
