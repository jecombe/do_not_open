import { spec } from "@dno/game-spec";
import { Box, C, Crate, Heads, Lane, Pipe } from "./croq";
import { RAMP_PCT } from "./fees";
import { useT } from "./i18n";

/**
 * The bureau de change as a map of its five tokens: three plain ones in the light, two sealed
 * ones in the dark, and every road the bureau knows between them.
 */
export function BureauFigure() {
  const t = useT();
  const { symbol, confidentialSymbol } = spec.economy.token;
  const pct = { pct: RAMP_PCT };
  return (
    <figure className="diagram">
      <div className="diagram-scroll">
        <svg viewBox="0 0 960 400" role="img" aria-label={t("fig.bureau.aria")}>
          <Heads />
          <rect x={6} y={6} width={590} height={388} rx={14} fill="rgb(255 180 84 / 0.08)" stroke={C.sodium} strokeDasharray="4 8" />
          <text x={22} y={34} className="croq-svg-zone" fill={C.sodium}>
            {t("fig.bureau.plain")}
          </text>
          <rect x={640} y={6} width={314} height={388} rx={14} fill="rgb(125 227 208 / 0.07)" stroke={C.spectral} strokeDasharray="4 8" />
          <text x={656} y={34} className="croq-svg-zone" fill={C.spectral}>
            {t("fig.bureau.sealed")}
          </text>

          <Crate x={30} y={60} w={170} h={90} fill={C.paper} title="ETH" sub={t("fig.bureau.ethSub")} />
          <Crate x={310} y={60} w={200} h={90} fill={C.paper} title="USDC" sub={t("fig.bureau.usdcSub")} />
          <Crate x={310} y={260} w={200} h={90} fill={C.paper} title={symbol} sub={t("fig.bureau.croqSub")} />
          <Crate x={30} y={260} w={170} h={90} fill={C.tape} dashed title={t("fig.bureau.credits")} sub={t("fig.bureau.creditsSub")} />
          <Crate x={690} y={60} w={220} h={90} fill={C.spectral} title="cUSDC" sub={t("fig.bureau.cusdcSub")} symbol />
          <Crate x={690} y={260} w={220} h={90} fill={C.spectral} title={confidentialSymbol} sub={t("fig.bureau.ccroqSub")} symbol />

          <Pipe d="M204 105 L306 105" label={t("fig.bureau.ramp", pct)} lx={255} ly={93} color={C.sodium} />
          <Pipe d="M514 90 L686 90" label={t("fig.bureau.shield")} lx={555} ly={78} />
          <Pipe d="M686 124 L514 124" label={t("fig.bureau.unshield")} lx={555} ly={146} />
          <Pipe d="M514 290 L686 290" label={t("fig.bureau.seal")} lx={555} ly={278} />
          <Pipe d="M686 324 L514 324" label={t("fig.bureau.unseal")} lx={555} ly={346} />
          <Pipe d="M380 154 L380 256" label={t("fig.bureau.buy")} lx={370} ly={200} color={C.sodium} anchor="end" />
          <Pipe d="M440 256 L440 154" label={t("fig.bureau.sell")} lx={450} ly={200} color={C.sodium} anchor="start" />
          <text x={452} y={224} className="croq-svg-note">
            {t("fig.bureau.pool")}
          </text>
          <Pipe d="M318 154 C280 220 240 230 204 268" label={t("fig.bureau.buyCredits")} lx={232} ly={204} color={C.tape} anchor="end" />
          <text x={584} y={380} textAnchor="end" className="croq-svg-note">
            {t("fig.bureau.border")}
          </text>
        </svg>
      </div>
      <div className="diagram-phone" role="img" aria-label={t("fig.bureau.aria")}>
        <div className="croq-zone" style={{ borderColor: C.sodium, background: "rgb(255 180 84 / 0.08)" }}>
          <p className="croq-zone-head" style={{ color: C.sodium }}>
            {t("fig.bureau.plain")}
          </p>
          <Box fill={C.paper} title="ETH" sub={t("fig.bureau.ethSub")} />
          <div className="croq-lanes is-single">
            <Lane color={C.sodium} label={t("fig.bureau.ramp", pct)} />
          </div>
          <Box fill={C.paper} title="USDC" sub={t("fig.bureau.usdcSub")} />
          <div className="croq-lanes">
            <Lane side="left" color={C.sodium} label={t("fig.bureau.buy")} note={t("fig.bureau.pool")} />
            <Lane up color={C.sodium} label={t("fig.bureau.sell")} />
          </div>
          <Box fill={C.paper} title={symbol} sub={t("fig.bureau.croqSub")} />
          <p className="croq-note">{t("fig.bureau.creditsNote")}</p>
        </div>
        <div className="croq-lanes">
          <Lane side="left" color={C.tape} label={`${t("fig.bureau.shield")}, ${t("fig.bureau.seal")}`} />
          <Lane up color={C.tape} label={`${t("fig.bureau.unshield")}, ${t("fig.bureau.unseal")}`} />
        </div>
        <p className="croq-note">{t("fig.bureau.border")}</p>
        <div className="croq-zone" style={{ borderColor: C.spectral, background: "rgb(125 227 208 / 0.07)" }}>
          <p className="croq-zone-head" style={{ color: C.spectral }}>
            {t("fig.bureau.sealed")}
          </p>
          <div className="croq-split">
            <Box fill={C.spectral} title="cUSDC" sub={t("fig.bureau.cusdcSub")} symbol />
            <Box fill={C.spectral} title={confidentialSymbol} sub={t("fig.bureau.ccroqSub")} symbol />
          </div>
        </div>
      </div>
      <figcaption>{t("fig.bureau.caption")}</figcaption>
    </figure>
  );
}
