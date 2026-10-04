import { useEffect, useMemo, useState } from "react";
import type { BoxSummary } from "@dno/chain-adapter";
import type { CatSpec } from "@dno/generator";
import { catFromRevealed } from "../chain/copy";
import { buildBoxSpec } from "@dno/generator";
import type { QualitySettings } from "@dno/scene";
import { useChain } from "../chain/ChainProvider";
import { holderCopy } from "../chain/copy";
import { useT } from "../i18n/app";
import { WarehouseScene, type WarehouseBox } from "../scenes/Warehouse";
import { Stage } from "./Stage";
import { useFold } from "./useFold";

interface Props {
  quality: QualitySettings;
  /** The box to stand in front of on arrival, e.g. the one just looked at. */
  focus: number | null;
  onInspect: (tokenId: number) => void;
}

/** Summaries are read a chunk at a time, so the first racks fill in while the rest load. */
const CHUNK = 96;

export function WarehouseView({ quality, focus, onInspect }: Props) {
  const { adapter, account, collection, myBoxes } = useChain();
  const t = useT();
  const { foldClass, foldButton } = useFold();
  const count = collection?.tokenCount ?? 0;
  const [rows, setRows] = useState<Map<number, BoxSummary>>(new Map());
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(focus);
  const [flight, setFlight] = useState(0);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    void (async () => {
      for (let lo = 0; lo < count && live; lo += CHUNK) {
        try {
          const chunk = await adapter.boxSummaries(lo, Math.min(count, lo + CHUNK));
          if (!live) return;
          setRows((prev) => {
            const next = new Map(prev);
            for (const r of chunk) next.set(r.tokenId, r);
            return next;
          });
        } catch {
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [adapter, count]);

  // Opened boxes show their cats: the chain made their seeds public, so anyone may draw them.
  const [cats, setCats] = useState<Map<number, CatSpec>>(new Map());
  useEffect(() => {
    let live = true;
    adapter.openedCats().then(
      (list) => live && setCats(new Map(list.map((c) => [c.tokenId, catFromRevealed(c.revealed)]))),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [adapter, count]);

  const boxes = useMemo(() => {
    const m = new Map<number, WarehouseBox>();
    const yours = new Set(myBoxes);
    for (const [id, r] of rows) m.set(id, { state: r.status, mine: yours.has(id) });
    return m;
  }, [rows, myBoxes]);
  const opened = useMemo(() => [...rows.values()].filter((r) => r.status === "revealed").length, [rows]);
  const mine = useMemo(() => [...boxes.values()].filter((b) => b.mine).length, [boxes]);

  const pick = (tokenId: number) => {
    setSelected(tokenId);
    setFlight((f) => f + 1);
  };

  // Arriving from a box: stand in front of it.
  useEffect(() => {
    if (focus !== null && focus < count) pick(focus);
  }, [focus, count]);

  const find = () => {
    const n = Number.parseInt(query.replace(/\D/g, ""), 10);
    if (Number.isFinite(n) && n >= 0 && n < count) pick(n);
  };

  const shown = hovered ?? selected;
  const row = shown !== null ? rows.get(shown) : undefined;
  const status = (s: BoxSummary["status"] | undefined) =>
    s === undefined ? "…" : s === "revealed" ? t("status.open") : s === "opening" ? t("status.opening") : t("status.sealed");

  return (
    <>
      <Stage quality={quality}>
        <WarehouseScene count={count} boxes={boxes} cats={cats} quality={quality} selected={selected} flight={flight} onHover={setHovered} onPick={pick} />
      </Stage>

      <section className={`slip${foldClass}`} aria-label={t("wh.title")}>
        {foldButton}
        <div className="slip-head">
          <span>{t("wh.title")}</span>
          <span>{t("wh.count", { count, open: opened })}</span>
        </div>

        {shown !== null && shown < count ? (
          <>
            <p className="serial">{buildBoxSpec(shown).serial}</p>
            <dl className="fields">
              <div>
                <dt>{t("wh.state")}</dt>
                <dd>{status(row?.status)}</dd>
              </div>
              <div>
                <dt>{t("box.holder")}</dt>
                <dd>{row ? holderCopy(myBoxes.includes(shown)) : "…"}</dd>
              </div>
            </dl>
            {selected !== null && (
              <button type="button" className="stamp-button" onClick={() => onInspect(selected)}>
                {t("wh.inspect", { serial: buildBoxSpec(selected).serial })}
              </button>
            )}
          </>
        ) : (
          <p className="state-note">{count === 0 ? t("wh.empty") : t("wh.pick")}</p>
        )}

        <form
          className="find"
          onSubmit={(e) => {
            e.preventDefault();
            find();
          }}
        >
          <label htmlFor="wh-find">{t("wh.find")}</label>
          <input id="wh-find" inputMode="numeric" placeholder="DNO-0000" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" className="plain-button" disabled={!count}>
            {t("wh.go")}
          </button>
        </form>

        <ul className="legend">
          <li>
            <span className="swatch swatch-sealed" aria-hidden="true" />
            {t("wh.legendSealed")}
          </li>
          <li>
            <span className="swatch swatch-open" aria-hidden="true" />
            {t("wh.legendOpen")}
          </li>
          {account && (
            <li>
              <span className="swatch swatch-mine" aria-hidden="true" />
              {t("wh.legendMine", { count: mine })}
            </li>
          )}
        </ul>

        <p className="fine">
          <span className="hint-pointer">{t("wh.hint")}</span>
          <span className="hint-touch">{t("wh.hintTouch")}</span>
        </p>
      </section>
    </>
  );
}
