import type { Tweet, TweetLookup } from "../../application/xPass";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ", mdash: "—" };

/** The text of oEmbed's HTML: tags dropped, the common entities decoded. */
export function oEmbedText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[e.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads a tweet through X's public oEmbed endpoint: no key, no account. It answers for public
 * posts only, which is what a boarding tweet is.
 */
export class OEmbedTweets implements TweetLookup {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly endpoint = "https://publish.x.com/oembed",
  ) {}

  async tweet(handle: string, id: string): Promise<Tweet | null> {
    const url = `${this.endpoint}?url=${encodeURIComponent(`https://twitter.com/${handle}/status/${id}`)}&omit_script=true&dnt=true`;
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(8_000) });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`oEmbed ${res.status}`);
    const body = (await res.json()) as { author_url?: string; html?: string };
    const author = /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/.exec(body.author_url ?? "");
    if (!author || !body.html) return null;
    return { id, handle: author[1]!.toLowerCase(), text: oEmbedText(body.html) };
  }
}
