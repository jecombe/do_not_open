import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  server: { port: 5173 },
  build: { rollupOptions: { input: { home: "index.html", app: "app.html", docs: "docs.html", render: "render.html" } } },
});
