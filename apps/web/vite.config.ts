import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The home page, the manual and the studio have one path per language (`/fr/`, `/fr/docs`, `/fr/studio`). The build writes
 * a file for each (scripts/prerender.mts); the dev server serves the English source page for them,
 * and the page reads its language from the path.
 */
function localizedPaths(): Plugin {
  const LOCALIZED = /^\/(?:fr|es|it)(\/(?:index(?:\.html)?|docs(?:\.html)?|studio(?:\.html)?)?)?\/?(\?.*)?$/;
  return {
    name: "dno-localized-paths",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const m = req.url ? LOCALIZED.exec(req.url) : null;
        if (m) req.url = `${m[1]?.startsWith("/docs") ? "/docs.html" : m[1]?.startsWith("/studio") ? "/studio.html" : "/index.html"}${m[2] ?? ""}`;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localizedPaths()],
  envDir: "../..",
  server: { port: 5173 },
  build: { rollupOptions: { input: { home: "index.html", app: "app.html", docs: "docs.html", studio: "studio.html", render: "render.html" } } },
});
