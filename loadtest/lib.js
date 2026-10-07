// What the k6 scripts share: the seeded world (apps/api/scripts/seedLoad.ts) and the summary.

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:8080").replace(/\/$/, "");
/** Boxes and players the seed made (SEED_BOXES, SEED_PLAYERS). */
export const BOXES = Number(__ENV.BOXES || 4000);
export const PLAYERS = Number(__ENV.PLAYERS || 600);
export const DUELS = Number(__ENV.DUELS || 400);
/** Names the run in its files and table: "replicas-3". */
export const LABEL = __ENV.LABEL || "run";
/** Where the summary files go; unset, the table is only printed (a run by hand leaves nothing behind). */
const OUT_DIR = (__ENV.SUMMARY_DIR || "").replace(/\/$/, "");

/** The seed's player addresses, fixed by their index. */
export const playerAddress = (i) => `0x${(0xd0000000 + i).toString(16).padStart(40, "0")}`;

/** The n-th address of 100.64/10 (4 million of them): a player of its own to the proxy. */
export const ipOf = (n) => `100.${64 + ((n >> 16) & 63)}.${(n >> 8) & 255}.${n & 255}`;

const ms = (v) => (v === undefined ? "–" : `${v.toFixed(1)} ms`);
const pct = (v) => (v === undefined ? "–" : `${(v * 100).toFixed(2)} %`);

/** The figures one run is judged on, flat, for the job's comparison table. */
function figures(data) {
  const m = data.metrics;
  const v = (name, stat) => m[name]?.values?.[stat];
  return {
    label: LABEL,
    requests: v("http_reqs", "count"),
    rps: v("http_reqs", "rate"),
    p95: v("http_req_duration{kind:index}", "p(95)"),
    p99: v("http_req_duration{kind:index}", "p(99)"),
    chainP95: v("http_req_duration{kind:chain}", "p(95)"),
    failed: v("http_req_failed", "rate"),
    checks: v("checks", "rate"),
    thresholdsFailed: Object.entries(m)
      .filter(([, x]) => x.thresholds && Object.values(x.thresholds).some((t) => !t.ok))
      .map(([name]) => name),
  };
}

/** k6's own data, the flat figures, and a few lines of markdown, next to each other. */
export function summarize(data, extra = {}) {
  const f = { ...figures(data), ...extra };
  const lines = [
    `### ${f.label}`,
    "",
    "| requests | req/s | p95 (index) | p99 (index) | p95 (chain) | errors | checks | thresholds |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    `| ${f.requests ?? "–"} | ${f.rps?.toFixed(1) ?? "–"} | ${ms(f.p95)} | ${ms(f.p99)} | ${ms(f.chainP95)} | ${pct(f.failed)} | ${pct(f.checks)} | ${f.thresholdsFailed.length ? `failed: ${f.thresholdsFailed.join(", ")}` : "ok"} |`,
    "",
  ];
  const stdout = `${lines.join("\n")}\n`;
  if (!OUT_DIR) return { stdout };
  return {
    [`${OUT_DIR}/${LABEL}.k6.json`]: JSON.stringify(data, null, 2),
    [`${OUT_DIR}/${LABEL}.json`]: JSON.stringify(f, null, 2),
    [`${OUT_DIR}/${LABEL}.md`]: lines.join("\n"),
    stdout,
  };
}
