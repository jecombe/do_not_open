import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "../../docs/docs.css";
import { createRoot } from "react-dom/client";
import { startAnalytics } from "../../analytics";
import { VaultDocs } from "./VaultDocs";

startAnalytics();
createRoot(document.getElementById("root")!).render(<VaultDocs />);
