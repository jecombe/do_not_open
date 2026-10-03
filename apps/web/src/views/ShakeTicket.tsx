import { spec as gameSpec } from "@dno/game-spec";
import { felt, TICKET_LINES, type Ticket } from "../chain/ticketStore";
import { useLocale } from "../i18n/locale";
import { useT } from "../i18n/app";
import { rollNames, traitName } from "../i18n/names";

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
      <p className="ticket-foot">
        <span>{t("ticket.count", { felt: count, total: TICKET_LINES })}</span>
        <span>{t("ticket.shakes", { count: ticket.shakes })}</span>
      </p>
      <p className="ticket-fine">{opened ? t("ticket.opened") : t("ticket.private")}</p>
    </figure>
  );
}
