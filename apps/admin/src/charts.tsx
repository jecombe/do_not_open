import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DayRow } from "./api";
import { dayLabel, dayLong, fmt, pct } from "./format";

/** The width of an element, followed as it changes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A round number at or above `n`, for the top of an axis. */
function niceCeil(n: number): number {
  if (n <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * mag >= n) return step * mag;
  return 10 * mag;
}

export interface Series {
  key: string;
  label: string;
  color: string;
  /** Bars stack under the lines. Default: bar. */
  kind?: "bar" | "line";
  /** What the legend shows for the period: the sum, or the busiest day (a distinct count does not add up). */
  total?: "sum" | "max";
}

/** Day by day: stacked bars and lines, with the day's figures on hover. */
export function TimeChart({ rows, series, height = 240 }: { rows: DayRow[]; series: Series[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const bars = series.filter((s) => (s.kind ?? "bar") === "bar");
  const lines = series.filter((s) => s.kind === "line");
  const v = (r: DayRow, key: string) => Number(r[key] ?? 0);
  const top = niceCeil(Math.max(1, ...rows.map((r) => bars.reduce((a, s) => a + v(r, s.key), 0)), ...rows.flatMap((r) => lines.map((s) => v(r, s.key)))));

  const pad = { l: 40, r: 10, t: 10, b: 24 };
  const w = Math.max(0, width - pad.l - pad.r);
  const h = height - pad.t - pad.b;
  const band = rows.length ? w / rows.length : 0;
  const x = (i: number) => pad.l + i * band;
  const y = (n: number) => pad.t + h - (n / top) * h;
  const labelEvery = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(w / 64))));
  const totals = series.map((s) => (s.total === "max" ? Math.max(0, ...rows.map((r) => v(r, s.key))) : rows.reduce((a, r) => a + v(r, s.key), 0)));
  // Gridlines on whole numbers.
  const ticks = top % 4 === 0 ? 4 : top % 5 === 0 ? 5 : 2;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - pad.l) / band);
    setHover(i >= 0 && i < rows.length ? i : null);
  };
  const hovered = hover !== null ? rows[hover] : undefined;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
          {Array.from({ length: ticks + 1 }, (_, i) => i / ticks).map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={pad.l + w} y1={y(top * f)} y2={y(top * f)} className="grid" />
              <text x={pad.l - 6} y={y(top * f) + 4} className="axis" textAnchor="end">
                {fmt(Math.round(top * f))}
              </text>
            </g>
          ))}
          {hover !== null && <rect x={x(hover)} y={pad.t} width={band} height={h} className="hoverband" />}
          {rows.map((r, i) => {
            let acc = 0;
            return (
              <g key={r.day}>
                {bars.map((s) => {
                  const n = v(r, s.key);
                  if (!n) return null;
                  const y0 = y(acc);
                  acc += n;
                  return <rect key={s.key} x={x(i) + band * 0.15} width={Math.max(1, band * 0.7)} y={y(acc)} height={Math.max(1, y0 - y(acc))} fill={s.color} rx={Math.min(3, band * 0.1)} />;
                })}
                {i % labelEvery === 0 && (
                  <text x={x(i) + band / 2} y={height - 6} className="axis" textAnchor="middle">
                    {dayLabel(r.day)}
                  </text>
                )}
              </g>
            );
          })}
          {lines.map((s) => (
            <polyline key={s.key} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" points={rows.map((r, i) => `${x(i) + band / 2},${y(v(r, s.key))}`).join(" ")} />
          ))}
          {hover !== null && lines.map((s) => <circle key={s.key} cx={x(hover) + band / 2} cy={y(v(rows[hover]!, s.key))} r={4} fill={s.color} />)}
        </svg>
      )}
      {hovered && hover !== null && (
        <div className="tooltip" style={{ left: Math.min(Math.max(0, x(hover) + band / 2 - 90), Math.max(0, width - 180)) }}>
          <strong>{dayLong(hovered.day)}</strong>
          {series.map((s) => (
            <div key={s.key}>
              <i style={{ background: s.color }} /> {s.label} <b>{fmt(v(hovered, s.key))}</b>
            </div>
          ))}
        </div>
      )}
      <div className="legend">
        {series.map((s, i) => (
          <span key={s.key}>
            <i style={{ background: s.color }} className={s.kind === "line" ? "line" : ""} /> {s.label} <b>{s.total === "max" ? `record ${fmt(totals[i]!)}` : fmt(totals[i]!)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A small trend line, filling its box. */
export function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((n, i) => `${(i / (values.length - 1)) * 100},${30 - (n / max) * 28}`);
  return (
    <svg className="spark" viewBox="0 0 100 31" preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,31 ${pts.join(" ")} 100,31`} fill={color} opacity={0.18} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Each step's count, its share of the first, and what it kept of the one before. */
export function Funnel({ steps }: { steps: { label: string; count: number }[] }) {
  const first = steps[0]?.count ?? 0;
  return (
    <div className="funnel">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1]!.count : null;
        const lost = prev !== null && prev > 0 ? prev - s.count : 0;
        return (
          <div className="step" key={s.label}>
            <div className="name">{s.label}</div>
            <div className="track">
              <div className="fill" style={{ width: first ? `${(s.count / first) * 100}%` : 0 }} />
              <span className="count">{fmt(s.count)}</span>
            </div>
            <div className="rates">
              <span title="part des cartes créées">{pct(s.count, first)}</span>
              {prev !== null && (
                <span className={lost > 0 ? "lost" : ""} title="gardés depuis l'étape d'avant">
                  {pct(s.count, prev)} {lost > 0 ? `(−${fmt(lost)})` : ""}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

/** Actions by weekday and hour, moved from UTC to the viewer's time zone. */
export function Heatmap({ grid }: { grid: number[][] }) {
  // Whole hours: every time zone the team is in.
  const offset = Math.round(-new Date().getTimezoneOffset() / 60);
  const local = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  grid.forEach((row, d) =>
    row.forEach((n, h) => {
      const t = d * 24 + h + offset;
      const k = ((t % 168) + 168) % 168;
      local[Math.floor(k / 24)]![k % 24]! += n;
    }),
  );
  const max = Math.max(1, ...local.flat());
  const best = local.flatMap((row, d) => row.map((n, h) => ({ n, d, h }))).sort((a, b) => b.n - a.n)[0];
  return (
    <div className="heatmap">
      <div className="hm-grid">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="hm-hour">
            {h % 3 === 0 ? `${h}h` : ""}
          </span>
        ))}
        {local.map((row, d) => (
          <Row key={d} label={DAYS[d]!}>
            {row.map((n, h) => (
              <span key={h} className="hm-cell" title={`${DAYS[d]} ${h}h–${h + 1}h : ${fmt(n)} actions`} style={{ background: n ? `rgba(255, 180, 84, ${0.12 + (n / max) * 0.88})` : undefined }} />
            ))}
          </Row>
        ))}
      </div>
      {best && best.n > 0 && (
        <p className="note">
          Créneau le plus actif : <b>{DAYS[best.d]} {best.h}h–{best.h + 1}h</b> (heure locale). Bon moment pour poster.
        </p>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="hm-day">{label}</span>
      {children}
    </>
  );
}

/** Horizontal bars for a few named counts. */
export function Bars({ items, color }: { items: { label: string; count: number }[]; color: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="bars">
      {items.map((i) => (
        <div key={i.label} className="bar">
          <span className="name">{i.label}</span>
          <span className="track">
            <span className="fill" style={{ width: `${(i.count / max) * 100}%`, background: color }} />
          </span>
          <b>{fmt(i.count)}</b>
        </div>
      ))}
    </div>
  );
}
