import type { Dashboard, XTask } from "../api";
import { Bars, Funnel, TimeChart } from "../charts";
import { duration, fmt, pct } from "../format";
import { C, stepLabel, TASK_LABEL } from "../labels";

export function Boarding({ d }: { d: Dashboard }) {
  const steps = d.funnel.map((s) => ({ label: stepLabel(s.step), count: s.count }));
  // The step that loses the most people, after the first one.
  const worst = d.funnel
    .slice(1)
    .map((s, i) => ({ step: s.step, lost: d.funnel[i]!.count - s.count, kept: d.funnel[i]!.count ? s.count / d.funnel[i]!.count : 1 }))
    .filter((s) => s.lost > 0 && !["wallet", "claimed", "discord"].includes(s.step))
    .sort((a, b) => a.kept - b.kept)[0];
  const tasks = (Object.keys(d.tasks) as XTask[]).map((t) => ({ label: `${TASK_LABEL[t]}${d.seats.required.includes(t) ? " *" : ""}`, count: d.tasks[t] }));
  const locales = Object.entries(d.ideasByLocale).sort((a, b) => b[1] - a[1]).map(([l, n]) => ({ label: l.toUpperCase(), count: n }));
  const passes = d.funnel[0]?.count ?? 0;
  const seated = d.funnel.find((s) => s.step === "seated")?.count ?? 0;

  return (
    <>
      <section className="facts">
        <div>
          <b>{pct(seated, passes)}</b> des cartes aboutissent à une place
        </div>
        <div>
          <b>{d.medianToSeat === null ? "–" : duration(d.medianToSeat)}</b> entre la carte et la place (médiane)
        </div>
        {worst && (
          <div className="warn">
            Plus grosse perte : <b>{stepLabel(worst.step)}</b>, {fmt(worst.lost)} personnes ({Math.round((1 - worst.kept) * 100)} % perdus à cette étape)
          </div>
        )}
      </section>
      <div className="cols">
        <section className="card wide">
          <h2>Funnel de la carte d'embarquement</h2>
          <Funnel steps={steps} />
          <p className="note">Pourcentage de gauche : part des cartes créées. À droite : gardés depuis l'étape d'avant. Les tâches sont déclarées par les joueurs (X ne permet pas de les vérifier sans API payante).</p>
        </section>
        <section className="card">
          <h2>Tâches X déclarées</h2>
          <Bars items={tasks} color={C.blue} />
          <p className="note">* exigée pour une place.</p>
          <h2 className="mt">Idées par langue</h2>
          {locales.length ? <Bars items={locales} color={C.tape} /> : <p className="empty">Aucune idée.</p>}
        </section>
      </div>
      <section className="card">
        <h2>Par jour</h2>
        <TimeChart
          rows={d.boarding}
          height={280}
          series={[
            { key: "passes", label: "Cartes créées", color: C.sodium },
            { key: "x", label: "X connectés", color: C.blue, kind: "line" },
            { key: "seated", label: "Places prises", color: C.green, kind: "line" },
            { key: "claims", label: "Claims", color: C.spectral, kind: "line" },
            { key: "discord", label: "Discord", color: C.violet, kind: "line" },
            { key: "ideas", label: "Idées", color: C.tape, kind: "line" },
          ]}
        />
      </section>
    </>
  );
}
