import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "../docs/docs.css";
import { createRoot } from "react-dom/client";
import { startAnalytics } from "../analytics";
import { getLocale } from "../i18n/locale";
import { docsPath } from "../site";
import { PROJECT_SECTIONS, ProjectDocs } from "./ProjectDocs";

// `/docs` on the bare domain used to be the game's manual: an old link to one of its chapters
// (`/docs#croquettes`) goes on to the manual, where that chapter is.
const anchor = location.hash.slice(1);
if (anchor && !(PROJECT_SECTIONS as readonly string[]).includes(anchor)) location.replace(`${docsPath(getLocale())}#${anchor}`);
else {
  startAnalytics();
  createRoot(document.getElementById("root")!).render(<ProjectDocs />);
}
