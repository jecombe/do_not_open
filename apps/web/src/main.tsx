import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startAnalytics } from "./analytics";
import { App } from "./App";
import { ChainProvider } from "./chain/ChainProvider";
import { liftIntro } from "./intro";

startAnalytics();

// Box textures are drawn on a canvas with these fonts, so they must be ready first.
const fonts = ['700 64px "Stardos Stencil"', '500 32px "Barlow Condensed"', '700 64px "Barlow Condensed"'];

Promise.all(fonts.map((f) => document.fonts.load(f)))
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <ChainProvider>
          <App />
        </ChainProvider>
      </StrictMode>,
    );
    // The stage lifts the curtain once its canvas is up; a view without one still opens it.
    window.setTimeout(liftIntro, 2500);
  });
