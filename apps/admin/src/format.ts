const number = new Intl.NumberFormat("fr-FR");
const dateTime = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const shortDay = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", timeZone: "UTC" });
const longDay = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

export const fmt = (n: number) => number.format(n);

export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)} %` : "–");

/** A change from `before` to `now`, as "+12 %", or null when there was nothing before. */
export function change(now: number, before: number): { text: string; up: boolean | null } {
  if (before === 0) return now === 0 ? { text: "=", up: null } : { text: "nouveau", up: true };
  const p = Math.round(((now - before) / before) * 100);
  return { text: `${p > 0 ? "+" : ""}${p} %`, up: p === 0 ? null : p > 0 };
}

export const when = (t: number) => dateTime.format(new Date(t * 1000));

/** "il y a 3 min", "il y a 2 j". */
export function ago(t: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - t));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86_400)} j`;
}

export function duration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400 * 2) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} j`;
}

export const dayLabel = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));
export const dayLong = (day: string) => longDay.format(new Date(`${day}T00:00:00Z`));

/** A CSV file the browser saves. */
export function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([`﻿${rows.map((r) => r.map(cell).join(",")).join("\n")}`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
