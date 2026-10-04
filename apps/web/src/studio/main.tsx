import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "../styles.css";
import "./studio.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startAnalytics } from "../analytics";
import { StudioPage } from "./StudioPage";

startAnalytics();

// The cats' kit draws nothing with fonts, but the masthead's stamp does.
const fonts = ['700 64px "Stardos Stencil"', '500 32px "Barlow Condensed"', '700 64px "Barlow Condensed"'];

Promise.all(fonts.map((f) => document.fonts.load(f)))
  .catch(() => undefined)
  .then(() =>
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <StudioPage />
      </StrictMode>,
    ),
  );
