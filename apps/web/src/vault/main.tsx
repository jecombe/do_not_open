import "@fontsource/stardos-stencil/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "../secure/secure.css";
import "./vault.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startAnalytics } from "../analytics";
import { ChainProvider } from "../chain/ChainProvider";
import { VaultPage } from "./VaultPage";

startAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChainProvider>
      <VaultPage />
    </ChainProvider>
  </StrictMode>,
);
