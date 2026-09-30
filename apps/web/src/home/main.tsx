import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "./home.css";
import { createRoot } from "react-dom/client";
import { Home } from "./Home";

// The box's label is drawn on a canvas with these fonts, so they must be ready first.
const fonts = ['700 64px "Stardos Stencil"', '500 32px "Barlow Condensed"', '700 64px "Barlow Condensed"'];

Promise.all(fonts.map((f) => document.fonts.load(f)))
  .catch(() => undefined)
  .then(() => createRoot(document.getElementById("root")!).render(<Home />));
