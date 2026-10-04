import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import type { RatInfo, RatPantryInfo } from "@dno/chain-adapter";
import { studio } from "@dno/game-spec";
import { buildRatSpec, renderRatSvg } from "@dno/generator";
import { createRat, DEPOT_COLORS, type QualitySettings } from "@dno/scene";
import { useAction, useChain, useLedger } from "../chain/ChainProvider";
import { useT } from "../i18n/app";
import { useLocale } from "../i18n/locale";
import { studioPath } from "../site";
import { DEMO_RAT_URI } from "../studio/service";
import { loadToonModel, type StageObject } from "../studio/toonModel";
import { ProblemNote } from "./ProblemNote";
import { Stage } from "./Stage";
import { TxPending } from "./TxPending";
import { useFold } from "./useFold";

/** The seed a rat is drawn from: its own for a free rat; the demo's AI rats name one in their record. */
function seedOf(rat: RatInfo): bigint | null {
  if (rat.seed) return BigInt(rat.seed);
  if (rat.uri?.startsWith(DEMO_RAT_URI)) return BigInt(rat.uri.slice(DEMO_RAT_URI.length));
  return null;
}

/** A small picture of a rat: the API's when it has one, else the generator's drawing of its seed. */
function thumbOf(rat: RatInfo): string | null {
  if (rat.imageUrl) return rat.imageUrl;
  const seed = seedOf(rat);
  return seed === null ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderRatSvg(buildRatSpec(seed)))}`;
}

/** One rat on the depot floor, turned with a drag. */
function RatScene({ rat }: { rat: RatInfo | null }) {
  const camera = useThree((s) => s.camera);
  const [object, setObject] = useState<StageObject | null>(null);

  useEffect(() => {
    // On a phone the slip takes the bottom half: the rat stands further off to fit above it.
    if (window.matchMedia("(max-width: 700px)").matches) camera.position.set(4.2, 2.3, 7.2);
    else camera.position.set(2.3, 1.5, 3.9);
  }, [camera]);

  useEffect(() => {
    setObject(null);
    if (!rat) return;
    let live = true;
    let made: StageObject | null = null;
    const seed = seedOf(rat);
    if (seed !== null) {
      made = createRat(buildRatSpec(seed));
      setObject(made);
    } else if (rat.modelUrl) {
      loadToonModel(rat.modelUrl).then(
        (m) => (live ? ((made = m), setObject(m)) : m.dispose()),
        () => undefined,
      );
    }
    return () => {
      live = false;
      made?.dispose();
    };
  }, [rat]);

  useFrame(({ clock }) => object?.update(clock.elapsedTime));

  return (
    <>
      <color attach="background" args={[DEPOT_COLORS.shadow]} />
      <hemisphereLight args={["#FFE9C4", "#2A2018", 1.2]} />
      <directionalLight position={[3, 5, 2]} intensity={2} color="#FFE9CC" />
      <mesh rotation-x={-Math.PI / 2}>
        <circleGeometry args={[1.6, 48]} />
        <meshLambertMaterial color={DEPOT_COLORS.concrete} />
      </mesh>
      {object && <primitive object={object.group} />}
      <OrbitControls makeDefault target={[0, 0.5, 0]} enablePan={false} minDistance={1.4} maxDistance={10} maxPolarAngle={1.45} />
    </>
  );
}

/**
 * The account's rats: one on the floor, the others as thumbnails. Each earns plain CROQ a day
 * from the RatPantry, collected here for all of them at once; and a paid shake of a sealed box
 * is a rat sniffing it.
 */
export function RatsView({ quality, onSniff }: { quality: QualitySettings; onSniff: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { adapter, account, connect } = useChain();
  const ledger = useLedger();
  const action = useAction();
  const { foldClass, foldButton } = useFold();
  const [rats, setRats] = useState<RatInfo[] | null>(null);
  const [due, setDue] = useState<bigint[]>([]);
  const [pantry, setPantry] = useState<RatPantryInfo | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [paid, setPaid] = useState<bigint | null>(null);

  useEffect(() => {
    let live = true;
    adapter.ratPantry().then(
      (p) => live && setPantry(p),
      () => live && setPantry(null),
    );
    if (!account) {
      setRats(null);
      return;
    }
    adapter
      .ratsOf(account)
      .then(async (list) => {
        const owed = await adapter.ratClaimable(list.map((r) => r.id));
        if (live) (setRats(list), setDue(owed), setFailed(false));
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [adapter, account, ledger]);

  const total = useMemo(() => due.reduce((a, b) => a + b, 0n), [due]);
  const rat = rats?.[Math.min(selected, (rats?.length ?? 1) - 1)] ?? null;
  const perDay = pantry?.perDay ?? studio.rats.croquettes.perDay;

  const collect = async () => {
    if (!rats?.length) return;
    setPaid(null);
    const got = await action.run("rat-collect", (o) => adapter.claimRatCroq(rats.map((r) => r.id), o));
    if (got !== undefined) setPaid(got);
  };

  return (
    <>
      <Stage quality={quality}>
        <RatScene rat={rat} />
      </Stage>
      <section className={`slip rats${foldClass}`} aria-label={t("rats.title")}>
        {foldButton}
        <div className="slip-head">
          <span>{t("rats.title")}</span>
        </div>
        <TxPending busy={action.busy} step={action.step} title={t("rats.collecting")}>
          {pantry === null ? (
            <p className="state-note">{t("rats.closed")}</p>
          ) : !account ? (
            <>
              <p className="state-note">{t("rats.connectFirst")}</p>
              <button type="button" className="stamp-button" onClick={() => void connect()}>
                {t("rats.connect")}
              </button>
            </>
          ) : failed ? (
            <p className="fine problem">{t("rats.failed")}</p>
          ) : rats === null ? (
            <p className="state-note">{t("rats.reading")}</p>
          ) : rats.length === 0 ? (
            <>
              <p className="state-note">{t("rats.empty", { perDay })}</p>
              <a className="stamp-button" href={studioPath(locale)}>
                {t("rats.toStudio")}
              </a>
            </>
          ) : (
            <>
              <p className="fine">{t("rats.lead", { perDay, maxDays: pantry?.maxDays ?? studio.rats.croquettes.maxDays })}</p>
              <ul className="rats-list" role="list">
                {rats.map((r, i) => {
                  const thumb = thumbOf(r);
                  return (
                    <li key={r.id}>
                      <button type="button" className="rats-card" aria-pressed={r === rat} onClick={() => setSelected(i)}>
                        {thumb ? <img src={thumb} alt="" width={64} height={64} loading="lazy" /> : <span className="rats-thumb" aria-hidden="true" />}
                        <span className="rats-card-text">
                          <strong>{t("rats.name", { id: r.id })}</strong>
                          <span className="fine">{r.kind === "model" ? t("rats.kind.model") : t("rats.kind.seed")}</span>
                          <span className="fine">{t("rats.waiting", { n: (due[i] ?? 0n).toString() })}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <dl className="fields rats-fields">
                <div>
                  <dt>{t("rats.total")}</dt>
                  <dd>{t("rats.croq", { n: Number(total).toLocaleString(locale) })}</dd>
                </div>
                <div>
                  <dt>{t("rats.sniffed")}</dt>
                  <dd>{rat?.sniffs ?? 0}</dd>
                </div>
                {pantry && (
                  <div>
                    <dt>{t("rats.reserve")}</dt>
                    <dd>{t("rats.croq", { n: Number(pantry.reserve).toLocaleString(locale) })}</dd>
                  </div>
                )}
              </dl>
              <div className="actions">
                <button type="button" className="stamp-button" onClick={() => void collect()} disabled={!!action.busy || total === 0n}>
                  {t("rats.collect")}
                </button>
                <button type="button" className="plain-button" onClick={onSniff} disabled={!!action.busy}>
                  {t("rats.sniff")}
                </button>
              </div>
              {paid !== null && (
                <p className="fine" role="status">
                  {t("rats.paid", { n: paid.toString() })}
                </p>
              )}
              <p className="fine">{t("rats.sniffHint")}</p>
              {action.error && <ProblemNote problem={action.error} />}
            </>
          )}
        </TxPending>
      </section>
    </>
  );
}
