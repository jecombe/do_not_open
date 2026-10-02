import { useCallback, useEffect, useMemo, useState } from "react";
import { ChainError, onShelf, sameAddress, shortAddress, type DuelInfo } from "@dno/chain-adapter";
import { spec } from "@dno/game-spec";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings, ShakeSound } from "@dno/scene";
import { useAction, useChain } from "../chain/ChainProvider";
import { useT, type AppKey } from "../i18n/app";
import { SHELF_CAPACITY, ShelfScene, type ShelfBox } from "../scenes/Scenes";
import { FindMine } from "./FindMine";
import { Stage } from "./Stage";
import { type PlannedStep } from "./StepTracker";
import { TxPending } from "./TxPending";
import { useFold } from "./useFold";
import { ProblemNote } from "./ProblemNote";
import { boxTags, timeLeftCopy } from "../chain/tags";

interface Props {
  quality: QualitySettings;
  sound: ShakeSound;
  /** One of the account's boxes to put up, picked before coming here. */
  focus: number | null;
  onSelect: (tokenId: number) => void;
  /** Takes the duel up in the pair view: the account's box against the one on the shelf. */
  onFight: (mine: number, listed: number) => void;
}

const serial = (id: number) => buildBoxSpec(id).serial;
/** How many of the account's boxes are read to offer them. The newest come first. */
const LIST_LIMIT = 40;

const POST_PLAN: PlannedStep[] = [
  { step: "wallet", label: "track.post" },
  { step: "confirming", label: "track.chain" },
  { step: "decrypting", label: "track.decryptHolding" },
  { step: "proving", label: "track.proof" },
];
const PROVE_PLAN: PlannedStep[] = POST_PLAN.slice(2);
const WITHDRAW_PLAN: PlannedStep[] = [
  { step: "wallet", label: "track.withdraw" },
  { step: "confirming", label: "track.chain" },
];

/** A message key, so it follows a language change. */
type Note = Extract<AppKey, "duels.posted" | "duels.withdrawn">;

/**
 * The duel shelf: boxes their holders put up for a duel, proven held. Anyone with a sealed box
 * can take one up, or only the box it was reserved for. Who holds the boxes that take them up
 * stays unknown until the duel is decided.
 */
export function DuelShelfView({ quality, sound, focus, onSelect, onFight }: Props) {
  const { adapter, account, collection, myBoxes, boxesKnown, connect } = useChain();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const action = useAction();
  const [shelf, setShelf] = useState<DuelInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pointed, setPointed] = useState<number | null>(null);
  const [plan, setPlan] = useState<PlannedStep[] | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  // The account's duels posted without their proof (a decryption that failed, a tab closed):
  // they are not on the shelf until it is relayed.
  const [unproven, setUnproven] = useState<DuelInfo[]>([]);

  const load = useCallback(async () => {
    try {
      setShelf(await adapter.duelShelf());
      setFailed(false);
    } catch {
      setFailed(true);
    }
    if (!account) return setUnproven([]);
    try {
      setUnproven((await adapter.duels({ account, open: true })).filter((d) => d.status === "posted" && sameAddress(d.challenger, account)));
    } catch {
      // The next load tries again.
    }
  }, [adapter, account]);
  useEffect(() => void load(), [load, collection?.tokenCount]);

  // The account's sealed boxes: what it can put up, or take a duel up with.
  const [sealed, setSealed] = useState<number[]>([]);
  const listed = useMemo(() => [...myBoxes].reverse().slice(0, LIST_LIMIT), [myBoxes]);
  useEffect(() => {
    let live = true;
    void Promise.all(listed.map((id) => adapter.box(id)))
      .then((boxes) => live && setSealed(boxes.filter((b) => b.status === "sealed").map((b) => b.tokenId)))
      .catch(() => live && setSealed([]));
    return () => {
      live = false;
    };
  }, [adapter, listed]);

  const now = Date.now() / 1000;
  const live = useMemo(() => (shelf ?? []).filter((d) => onShelf(d, now)), [shelf, now]);
  const upAlready = new Set(live.filter((d) => sameAddress(d.challenger, account)).map((d) => d.tokenA));
  const postable = sealed.filter((id) => !upAlready.has(id));

  const [toPost, setToPost] = useState<number | null>(focus);
  useEffect(() => setToPost(focus), [focus]);
  const picked = toPost !== null && postable.includes(toPost) ? toPost : (postable[0] ?? null);
  // Empty: open to every sealed box. A token id: only that box may take it up.
  const [only, setOnly] = useState("");
  const onlyId = only.trim() === "" ? null : Number(only.trim().replace(/^DNO-/i, ""));
  const minted = collection?.tokenCount ?? 0;
  const onlyBad = onlyId !== null && (!Number.isSafeInteger(onlyId) || onlyId < 0 || onlyId >= minted || onlyId === picked);

  const post = async () => {
    if (picked === null || onlyBad) return;
    sound.resume();
    setNote(null);
    setPlan(POST_PLAN);
    const done = await action.run("post", (o) => adapter.postDuel(picked, { ...o, ...(onlyId !== null ? { reservedFor: onlyId } : {}) }), {
      resume: "problem.resumeDuelShelf",
    });
    if (done) {
      setNote("duels.posted");
      setOnly("");
    }
    await load();
  };

  /** Relays the proof that the account holds a posted box, which puts it on the shelf. */
  const prove = async (d: DuelInfo) => {
    sound.resume();
    setNote(null);
    setPlan(PROVE_PLAN);
    const done = await action.run("prove", async (o) => {
      await adapter.finishDuel(d.duelId, o);
      // A box the account no longer held voids the duel: the proof says so, and nothing else.
      if (!(await adapter.duelShelf()).some((x) => x.duelId === d.duelId)) throw new ChainError("not-yours", "The box did not go on the duel shelf.");
      return true;
    });
    if (done) setNote("duels.posted");
    await load();
  };

  const withdraw = async (d: DuelInfo) => {
    setNote(null);
    setPlan(WITHDRAW_PLAN);
    const done = await action.run("withdraw", async (o) => {
      await adapter.cancelDuel(d.duelId, o);
      return true;
    });
    if (done) setNote("duels.withdrawn");
    await load();
  };

  /** Which of the account's boxes would take `d` up: the one it is reserved for, or any other. */
  const taker = (d: DuelInfo): number | null => {
    if (d.reserved) return d.tokenB !== null && sealed.includes(d.tokenB) ? d.tokenB : null;
    // Rather a box that is not up itself: facing a box both up, the pair view would read two duels.
    const free = sealed.filter((id) => id !== d.tokenA);
    return free.find((id) => !upAlready.has(id)) ?? free[0] ?? null;
  };

  const timeLeft = (d: DuelInfo) => timeLeftCopy(d.openUntil ?? now, now);

  const onBench: ShelfBox[] = useMemo(
    () => live.slice(0, SHELF_CAPACITY).map((d) => ({ tokenId: d.tokenA, cat: null, tags: boxTags({ tokenId: d.tokenA, status: "sealed", partner: null }, [d], now) })),
    // `t` changes with the language the tags are worded in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live, t],
  );

  return (
    <>
      <Stage quality={quality}>
        <ShelfScene boxes={onBench} quality={quality} sound={sound} highlight={pointed} onSelect={onSelect} />
      </Stage>

      <section className={`slip${foldClass}`} aria-label={t("duels.title")}>
        {foldButton}
        <div className="slip-head">
          <span>{t("duels.title")}</span>
          {shelf && <span>{t("duels.count", { count: live.length })}</span>}
        </div>

        <TxPending busy={action.busy} step={action.step} title={action.busy === "post" ? t("duels.posting") : action.busy === "prove" ? t("duels.proving") : t("tx.working")} plan={plan}>
          <p className="fine">{t("duels.intro")}</p>

          {failed ? (
            <p className="state-note">{t("duels.unreadable")}</p>
          ) : !shelf ? (
            <p className="state-note">{t("footer.reading")}</p>
          ) : live.length === 0 ? (
            <p className="state-note">{t("duels.empty")}</p>
          ) : (
            <ul className="tags duel-list" aria-label={t("duels.list")}>
              {live.map((d) => {
                const mine = sameAddress(d.challenger, account);
                const with_ = mine ? null : taker(d);
                return (
                  <li key={d.duelId} onPointerEnter={() => setPointed(d.tokenA)} onPointerLeave={() => setPointed(null)} onFocus={() => setPointed(d.tokenA)} onBlur={() => setPointed(null)}>
                    <button type="button" onClick={() => onSelect(d.tokenA)}>
                      {serial(d.tokenA)}
                      <span>
                        {mine ? t("duels.byYou") : t("duels.by", { who: shortAddress(d.challenger) })}
                        {", "}
                        {d.reserved && d.tokenB !== null ? t("duels.onlyFor", { serial: serial(d.tokenB) }) : t("duels.anyBox")}
                        {", "}
                        {timeLeft(d)}
                      </span>
                    </button>
                    <span className="tag-options" role="group" aria-label={t("duels.actions", { serial: serial(d.tokenA) })}>
                      {!account ? null : mine ? (
                        <button type="button" onClick={() => void withdraw(d)} disabled={!!action.busy}>
                          {t("duels.withdraw")}
                        </button>
                      ) : with_ !== null ? (
                        <button type="button" onClick={() => onFight(with_, d.tokenA)} disabled={!!action.busy}>
                          {t("duels.takeUp")}
                        </button>
                      ) : (
                        <button type="button" disabled>
                          {d.reserved ? t("duels.notForYou") : t("duels.noBox")}
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {unproven.length > 0 && (
            <>
              <p className="slip-heading">{t("duels.unproven")}</p>
              <ul className="tags duel-list" aria-label={t("duels.unproven")}>
                {unproven.map((d) => (
                  <li key={d.duelId}>
                    <button type="button" onClick={() => onSelect(d.tokenA)}>
                      {serial(d.tokenA)}
                      <span>{t("shelf.duelToProve")}</span>
                    </button>
                    <span className="tag-options">
                      <button type="button" onClick={() => void prove(d)} disabled={!!action.busy}>
                        {action.busy === "prove" ? t("duels.proving") : t("duels.prove")}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="fine">{t("duels.unprovenHint")}</p>
            </>
          )}

          <p className="slip-heading">{t("duels.putUp")}</p>
          {!account ? (
            <>
              <p className="fine">{t("duels.connect")}</p>
              <button type="button" className="stamp-button" onClick={() => void connect()}>
                {t("nav.connect")}
              </button>
            </>
          ) : !boxesKnown ? (
            <FindMine compact />
          ) : postable.length === 0 ? (
            <p className="fine">{sealed.length ? t("duels.allUp") : t("duels.noneSealed")}</p>
          ) : (
            <>
              <div className="duel-form">
                <label>
                  {t("duels.yourBox")}
                  <select value={picked ?? ""} onChange={(e) => setToPost(Number(e.target.value))} disabled={!!action.busy}>
                    {postable.map((id) => (
                      <option key={id} value={id}>
                        {serial(id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("duels.onlyBox")}
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder={t("duels.anyone")}
                    value={only}
                    onChange={(e) => setOnly(e.target.value)}
                    disabled={!!action.busy}
                    aria-invalid={onlyBad}
                  />
                </label>
              </div>
              {onlyBad && <p className="fine problem">{t("duels.onlyBad")}</p>}
              <div className="actions">
                <button type="button" className="stamp-button" onClick={() => void post()} disabled={!!action.busy || picked === null || onlyBad}>
                  {action.busy === "post" ? t("duels.posting") : t("duels.post", { serial: picked === null ? "" : serial(picked) })}
                </button>
              </div>
              <p className="fine">{t("duels.postExplain", { days: Number(spec.mechanics.duel?.lifetimeDays ?? 7) })}</p>
            </>
          )}

          <div className="felt" aria-live="polite">
            {action.error ? (
              <ProblemNote problem={action.error} />
            ) : note ? (
              <p className="fine">{t(note)}</p>
            ) : null}
          </div>
        </TxPending>
      </section>
    </>
  );
}
