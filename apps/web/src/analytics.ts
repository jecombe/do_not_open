import { inject } from "@vercel/analytics";

/**
 * Vercel Web Analytics: page views only, no cookies. The query string is dropped before
 * anything is sent, so a `?box=` link never ties a visitor to a token id.
 */
export function startAnalytics(): void {
  inject({
    beforeSend: (event) => {
      const url = new URL(event.url);
      url.search = "";
      url.hash = "";
      return { ...event, url: url.toString() };
    },
  });
}
