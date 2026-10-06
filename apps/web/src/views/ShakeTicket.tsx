import { useMemo } from "react";
import { spec as gameSpec } from "@dno/game-spec";
import { estimateScore } from "@dno/generator";
import { felt, TICKET_LINES, type Ticket } from "../chain/ticketStore";
import { useLocale } from "../i18n/locale";
import { useT } from "../i18n/app";
import { rollNames, tierName, traitName } from "../i18n/names";

interface Props {
  serial: string;
  ticket: Ticket;
  /** The trait the latest shake printed: its line comes out of the slot. */
  printed: number | null;
  /** The rolls the chain made public once the box was opened: each line is checked against them. */
  opened: number[] | null;
  /** Where it is laid: inside the slip on a phone, beside it on a desktop. */
  className?: string;
}

/** "3 hours ago", "2 days ago", in the reader's language. */
const ago = (at: number, locale: string) => {
  const minutes = Math.round((Date.now() - at) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  return hours < 48 ? rtf.format(-hours, "hour") : rtf.format(-Math.round(hours / 24), "day");
};

/** What one account learned by shaking one box, printed like a till receipt and kept for good. */
export function ShakeTicket({ serial, ticket, printed, opened, className }: Props) {
  const t = useT();
  const locale = useLocale();
  const count = felt(ticket);
  // What the felt traits say about the score: the rest, and the state, are left to their odds.
  const estimate = useMemo(() => (opened || count === 0 ? null : estimateScore(ticket.lines.map((line) => line?.roll ?? null))), [opened, count, ticket]);
  const num = new Intl.NumberFormat(locale);
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  return (
    <figure className={`ticket${opened ? " is-void" : ""}${className ? ` ${className}` : ""}`} data-stamp={opened ? t("ticket.stamp") : undefined} aria-label={t("ticket.aria", { serial })}>
      <figcaption className="ticket-head">
        <span>{t("ticket.title")}</span>
        <span>{serial}</span>
      </figcaption>
      <ul>
        {Array.from({ length: TICKET_LINES }, (_, i) => {
          const line = ticket.lines[i];
          const def = gameSpec.traits[i]!;
          if (!line) {
            return (
              <li key={def.key} className="is-blank">
                <span>
                  {traitName(def.key)}: <strong>{t("ticket.unknown")}</strong>
                </span>
              </li>
            );
          }
          const { trait, variant } = rollNames(i, line.roll);
          const check = opened ? (rollNames(i, opened[i]!).variant === variant ? "ticket.right" : "ticket.wrong") : null;
          return (
            <li key={def.key} className={printed === i ? "is-printed" : undefined}>
              <span>
                {trait}: <strong>{variant}</strong>
              </span>
              <span className="ticket-when">{check ? t(check) : ago(line.lastAt, locale)}</span>
            </li>
          );
        })}
      </ul>
      {estimate && (
        <section className="ticket-estimate" aria-label={t("ticket.estimate")}>
          <p className="ticket-sub">
            <span>{t("ticket.estimate")}</span>
            <span>{t("ticket.points", { min: num.format(estimate.min), max: num.format(estimate.max) })}</span>
          </p>
          <ul>
            {estimate.tiers
              // Every tier the score can still land in, and any gap between them, so none looks skipped.
              .filter((_, i, all) => all.slice(0, i + 1).some((x) => x.chance > 0) && all.slice(i).some((x) => x.chance > 0))
              .map((tier) => (
                <li key={tier.key}>
                  <span>{tierName(tier.key)}</span>
                  <span className="ticket-bar" style={{ "--chance": tier.chance } as React.CSSProperties} aria-hidden="true" />
                  <span className="ticket-when">{tier.chance > 0 && tier.chance < 0.01 ? `< ${pct.format(0.01)}` : pct.format(tier.chance)}</span>
                </li>
              ))}
          </ul>
          <p className="ticket-fine">{t("ticket.estimateFine")}</p>
        </section>
      )}
      <p className="ticket-foot">
        <span>{t("ticket.count", { felt: count, total: TICKET_LINES })}</span>
        <span>{t("ticket.shakes", { count: ticket.shakes })}</span>
      </p>
      <p className="ticket-fine">{opened ? t("ticket.opened") : t("ticket.private")}</p>
    </figure>
  );
}
