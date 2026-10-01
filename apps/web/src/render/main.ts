import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/700.css";
import type { DiseaseKey } from "@dno/game-spec";
import { buildCatSpec } from "@dno/generator";
import { renderStill } from "./still";

/**
 * One still frame for token metadata, drawn with the same builders as the app.
 *
 *   /render.html?token=12                       a sealed box (token id only)
 *   /render.html?token=12&seed=0x..&affection=3 an opened one
 *   ...&weight=412000&sick=1&disease=diabetic   an opened one, weighed
 *
 * The result is left on `window.__dnoRender` as a PNG data URL for the script that drives
 * the page (scripts/render-metadata.cts).
 */
declare global {
  interface Window {
    __dnoRender?: string;
    __dnoRenderError?: string;
  }
}

async function render() {
  const params = new URLSearchParams(location.search);
  const tokenId = Number(params.get("token") ?? 0);
  const seed = params.get("seed");

  // Box labels are drawn on a canvas with these fonts.
  await Promise.all(['700 64px "Stardos Stencil"', '500 32px "Barlow Condensed"', '700 64px "Barlow Condensed"'].map((f) => document.fonts.load(f)));

  const weight = params.get("weight");
  const cat = seed
    ? buildCatSpec({
        seed,
        affection: Number(params.get("affection") ?? 0),
        weighIn:
          weight === null
            ? undefined
            : { weight: BigInt(weight), sick: params.get("sick") === "1", disease: (params.get("disease") as DiseaseKey | null) ?? null },
      })
    : null;
  const still = await renderStill({ tokenId, cat });
  document.body.append(still);
  window.__dnoRender = still.toDataURL("image/png");
}

render().catch((error) => {
  window.__dnoRenderError = String(error);
});
