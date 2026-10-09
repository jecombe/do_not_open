import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The home page, the docs (the project's, the game's manual, the vault's), the studio and the boarding page have one path per language (`/fr/`, `/fr/docs`, `/fr/project`, `/fr/vault-docs`, `/fr/studio`, `/fr/apply`). The build writes
 * a file for each (scripts/prerender.mts); the dev server serves the English source page for them,
 * and the page reads its language from the path.
 */
function localizedPaths(): Plugin {
  const LOCALIZED = /^\/(?:fr|es|it)(\/(?:index|docs|project|vault-docs|studio|apply)(?:\.html)?)?\/?(\?.*)?$/;
  const PAGE = /^\/(docs|project|vault-docs|studio|apply)/;
  return {
    name: "dno-localized-paths",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const m = req.url ? LOCALIZED.exec(req.url) : null;
        const page = `/${PAGE.exec(m?.[1] ?? "")?.[1] ?? "index"}.html`;
        if (m) req.url = `${page}${m[2] ?? ""}`;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localizedPaths()],
  envDir: "../..",
  server: { port: 5173 },
  build: { rollupOptions: { input: { home: "index.html", app: "app.html", docs: "docs.html", project: "project.html", vaultDocs: "vault-docs.html", studio: "studio.html", apply: "apply.html", vault: "vault.html", render: "render.html" } } },
});
