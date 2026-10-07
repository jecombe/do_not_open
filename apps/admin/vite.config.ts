import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The admin site. In production its domain is routed to the API under /admin, which serves this
 * build and its routes: the app asks `/api/...` on its own origin. Locally, the dev server sends
 * those to the API (`pnpm --filter @dno/api dev` with ADMIN_PASSWORD set).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { "/api": { target: process.env.ADMIN_API ?? "http://localhost:8080", rewrite: (path) => `/admin${path}` } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
