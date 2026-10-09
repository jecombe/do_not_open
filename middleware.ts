/**
 * Vercel's routing middleware: it runs before the static files, so the root of `game.` and
 * `vault.` can show the game and the vault while `/` stays the home page on the bare domain
 * (a rewrite in vercel.json would only run once `index.html` had already answered). The rules
 * live in apps/web/src/hosts/index.ts, which the pages share. Off the site's domains it does nothing.
 */
import { hostRoute } from "./apps/web/src/hosts";

// What `next()` and `rewrite()` from @vercel/functions answer, without the package: a dependency
// at the repo root would change how pnpm resolves the app's own (WalletConnect's optional peers).
const next = () => new Response(null, { headers: { "x-middleware-next": "1" } });
const rewrite = (to: URL) => new Response(null, { headers: { "x-middleware-rewrite": to.toString() } });

export const config = {
  matcher: ["/", "/app", "/vault", "/docs", "/apply", "/studio", "/:lang(fr|es|it)", "/:lang(fr|es|it)/:path*"],
};

export default function middleware(request: Request): Response {
  const url = new URL(request.url);
  const route = hostRoute(url);
  if (!route) return next();
  if ("rewrite" in route) return rewrite(new URL(route.rewrite, url));
  // Temporary: an address that moves again later is not stuck in browsers' caches.
  return Response.redirect(new URL(route.redirect, url), 307);
}
