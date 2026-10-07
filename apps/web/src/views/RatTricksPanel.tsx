import { useEffect, useState } from "react";
import type { RatInfo, RatPower, RatTrickPlayed, RatTricksInfo, TraitRoll } from "@dno/chain-adapter";
import { spec, studio } from "@dno/game-spec";
import { buildBoxSpec } from "@dno/generator";
import { fee, traitCopy } from "../chain/copy";
import { useChain, useLedger, type useAction } from "../chain/ChainProvider";
import { useT, type AppKey } from "../i18n/app";
import { useLocale } from "../i18n/locale";

type Action = ReturnType<typeof useAction>;

const POWER_NAME: Record<RatPower, AppKey> = { 1: "rats.power.1", 2: "rats.power.2", 3: "rats.power.3" };
const POWER_SAYS: Record<RatPower, AppKey> = { 1: "rats.power.1.says", 2: "rats.power.2.says", 3: "rats.power.3.says" };

/** "DNO-0012", "#12" or "12": the box's number. */
export function boxNumber(text: string): number | null {
  const digits = text.match(/(\d+)\s*$/)?.[1];
  if (!digits) return null;
  const id = Number(digits);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * What the selected rat can do besides earning croquettes: its secret power, read by its holder
 * alone; a sniff (a paid shake for the holder's eyes, cheaper for a power-1 rat); and a trick on
 * a box for a few days, which shields the player's own box or jams someone else's, decided by
 * the contract under encryption.
 */
export function RatTricksPanel({ rat, action }: { rat: RatInfo; action: Action }) {
  const t = useT();
  const locale = useLocale();
  const { adapter, collection } = useChain();
  const ledger = useLedger();
  const [info, setInfo] = useState<RatTricksInfo | null | undefined>(undefined);
  const [power, setPower] = useState<RatPower | null>(null);
  const [readyAt, setReadyAt] = useState<number | null>(null);
  const [boxText, setBoxText] = useState("");
  const [trait, setTrait] = useState(0);
  const [sniffed, setSniffed] = useState<{ tokenId: number; roll: TraitRoll } | null>(null);
  const [played, setPlayed] = useState<{ tokenId: number; at: RatTrickPlayed } | null>(null);

  useEffect(() => {
    let live = true;
    adapter.ratTricks().then(
      (i) => live && setInfo(i),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, [adapter]);

  // Another rat on the floor: what was read about the last one goes.
  useEffect(() => {
    setPower(null);
    setSniffed(null);
    setPlayed(null);
  }, [rat.id]);

  useEffect(() => {
    let live = true;
    adapter.ratReadyAt([rat.id]).then(
      ([at]) => live && setReadyAt(at ?? 0),
      () => live && setReadyAt(null),
    );
    return () => {
      live = false;
    };
  }, [adapter, rat.id, ledger]);

  if (!info) return null;

  const tokenId = boxNumber(boxText);
  const usdc = (amount: bigint) => fee(amount, collection);
  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(locale, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const serial = (id: number) => buildBoxSpec(id).serial;
  // The rule's days, as the spec states them: the demo's days are a minute long.
  const { trickDays, rechargeDays } = studio.rats.powers;
  const resting = readyAt !== null && readyAt > 0;

  const readPower = async () => {
    const p = await action.run("rat-power", (o) => adapter.ratPower(rat.id, o));
    if (p) setPower(p);
  };
  const sniff = async () => {
    if (tokenId === null) return;
    setPlayed(null);
    const roll = await action.run("rat-sniff", (o) => adapter.sniffWithRat(rat.id, tokenId, o));
    if (roll) setSniffed({ tokenId, roll });
  };
  const trick = async () => {
    if (tokenId === null) return;
    setSniffed(null);
    const at = await action.run("rat-trick", (o) => adapter.playTrick(rat.id, tokenId, trait, o));
    if (at) setPlayed({ tokenId, at });
  };

  return (
    <section className="rat-tricks" aria-label={t("rats.tricks.title")}>
      <h3>{t("rats.tricks.title")}</h3>
      <dl className="rat-facts">
        <div>
          <dt>{t("rats.power")}</dt>
          <dd>
            {power ? (
              <strong>{t(POWER_NAME[power])}</strong>
            ) : (
              <button type="button" className="link" onClick={() => void readPower()} disabled={!!action.busy}>
                {t("rats.power.read")}
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("rats.tricks.state")}</dt>
          <dd>{readyAt === null ? "…" : resting ? t("rats.tricks.resting", { when: when(readyAt) }) : t("rats.tricks.ready")}</dd>
        </div>
      </dl>
      {power && <p className="fine">{t(POWER_SAYS[power], { rebate: usdc(info.sniffRebate), fee: usdc(info.sniffFee) })}</p>}

      <div className="duel-form rat-form">
        <label>
          {t("rats.tricks.box")}
          <input inputMode="numeric" autoComplete="off" placeholder="DNO-0012" value={boxText} onChange={(e) => setBoxText(e.target.value)} disabled={!!action.busy} />
        </label>
        <label>
          {t("rats.tricks.trait")}
          <select value={trait} onChange={(e) => setTrait(Number(e.target.value))} disabled={!!action.busy}>
            {spec.traits.map((x) => (
              <option key={x.index} value={x.index}>
                {t(`trait.${x.key}` as AppKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        <button type="button" className="stamp-button" onClick={() => void sniff()} disabled={!!action.busy || tokenId === null}>
          {t("rats.sniffFor", { fee: usdc(info.sniffFee) })}
        </button>
        <button type="button" className="plain-button" onClick={() => void trick()} disabled={!!action.busy || tokenId === null || resting}>
          {t("rats.tricks.play", { days: trickDays })}
        </button>
      </div>

      {sniffed && (
        <p className="fine" role="status">
          {t("rats.sniffed.result", { serial: serial(sniffed.tokenId), ...traitCopy(sniffed.roll) })}
        </p>
      )}
      {played && (
        <p className="fine" role="status">
          {t("rats.tricks.played", { serial: serial(played.tokenId), until: when(played.at.until), ready: when(played.at.readyAt) })}
        </p>
      )}

      <details className="rat-how">
        <summary>{t("rats.how")}</summary>
        <ul>
          <li>{t("rats.how.secret")}</li>
          <li>{t("rats.how.p1", { rebate: usdc(info.sniffRebate), fee: usdc(info.sniffFee) })}</li>
          <li>{t("rats.how.p2")}</li>
          <li>{t("rats.how.p3")}</li>
          <li>{t("rats.how.trick", { days: trickDays, rest: rechargeDays })}</li>
          <li>{t("rats.how.shield")}</li>
          <li>{t("rats.how.jam")}</li>
          <li>{t("rats.how.hidden")}</li>
        </ul>
      </details>
    </section>
  );
}
