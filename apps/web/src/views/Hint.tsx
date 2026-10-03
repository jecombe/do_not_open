import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/app";

/** A "?" that opens its explanation on click or tap and keeps it until the × (or Escape, or a click elsewhere) closes it. */
export function Hint({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span className="hint" ref={ref}>
      <button type="button" className="hint-q" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      {open && (
        <span className="hint-q-body" role="note">
          <button type="button" className="hint-q-close" aria-label={t("hint.close")} onClick={() => setOpen(false)}>
            ×
          </button>
          {children}
        </span>
      )}
    </span>
  );
}
