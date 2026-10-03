import { useEffect, useId, useState } from "react";
import type { DecryptionAllowance } from "@dno/chain-adapter";
import { useChain, useLedger } from "./chain/ChainProvider";
import { useLive } from "./chain/useLive";
import { useT } from "./i18n/app";
import { useLocale } from "./i18n/locale";
import { Delta, Figure, Flash, useLiveValue } from "./LiveValue";
import { openExchange } from "./views/exchangeLink";

/** At or under this many units the meter starts blinking: about two shakes left. */
const LOW = 4;

/**
 * A counter of the decryptions left to the player: today's free units and the credits bought.
 * It blinks when they run low, turns red once they are gone, and a hover says what they are for.
 * A click opens the bureau de change on its credits window. Nothing shows where decryptions are free.
 */
export function CreditMeter() {
  const { adapter, account } = useChain();
  const t = useT();
  const lang = useLocale();
  const ledger = useLedger();
  const tipId = useId();
  const [allowance, setAllowance] = useState<DecryptionAllowance | null>(null);

  // Read again after every action, every block or so, and on coming back to the tab: the free
  // ones come back at midnight UTC.
  useLive(
    (live) =>
      void adapter.decryptionAllowance().then(
        (a) => live() && setAllowance(a),
        () => undefined,
      ),
    [adapter, account, ledger],
    !!account,
  );

  // A new account starts blank rather than showing the last one's count.
  useEffect(() => setAllowance(null), [account]);

  // Spent or bought, the units left roll to their new count.
  const free = useLiveValue(allowance ? BigInt(allowance.freeLeft) : null);
  const bought = useLiveValue(allowance ? BigInt(allowance.credits) : null);
  const units = useLiveValue(allowance ? BigInt(allowance.freeLeft + allowance.credits) : null);

  if (!account || !allowance) return null;
  const { freeLeft, freePerDay, credits, resetsAt } = allowance;
  const total = freeLeft + credits;
  const state = total === 0 ? "empty" : total <= LOW ? "low" : "ok";
  const reset = new Date(resetsAt * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

  return (
    <span className="credit-meter-wrap">
      <button type="button" className={`credit-meter is-${state}`} onClick={() => openExchange({ credits: true })} aria-describedby={tipId}>
        <Flash change={units.change} />
        <span className="balance-symbol">
          {t("meter.label")}
          <Delta change={units.change} format={String} />
        </span>
        <strong className="balance-value" aria-live="polite">
          <Figure change={free.change}>{String(free.shown ?? freeLeft)}</Figure>/{freePerDay}
          {credits > 0 && (
            <small>
              {" "}+<Figure change={bought.change}>{String(bought.shown ?? credits)}</Figure>
            </small>
          )}
        </strong>
      </button>
      <span className="credit-tip" id={tipId} role="tooltip">
        <strong className={`credit-tip-state is-${state}`}>{t(`meter.${state}`, { total })}</strong>
        <span>{t("meter.count", { free: freeLeft, perDay: freePerDay, credits })}</span>
        <span>{t("meter.what")}</span>
        <span>{t("meter.reset", { time: reset })}</span>
        <span className="credit-tip-go">{t("meter.buy")}</span>
      </span>
    </span>
  );
}
