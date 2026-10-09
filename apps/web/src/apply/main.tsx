import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "../secure/secure.css";
import "./apply.css";
import { createRoot } from "react-dom/client";
import { startAnalytics } from "../analytics";
import { ApplyPage } from "./ApplyPage";

startAnalytics();

// The boxes' labels are drawn on canvases with these fonts, so they must be ready first.
const fonts = ['700 64px "Stardos Stencil"', '500 32px "Barlow Condensed"', '700 64px "Barlow Condensed"'];

Promise.all(fonts.map((f) => document.fonts.load(f)))
  .catch(() => undefined)
  .then(() => createRoot(document.getElementById("root")!).render(<ApplyPage />));
