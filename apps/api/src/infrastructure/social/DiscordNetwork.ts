import { NetworkBusy, type SocialNetwork } from "../../application/ports/herald";

/** Discord's limit on a message's text. */
const MAX_CONTENT = 2000;

/**
 * Posts in a Discord channel through one of its webhooks (channel settings → Integrations →
 * Webhooks): no bot, no fee. Mentions are never parsed, so a post can't ping anyone.
 */
export class DiscordNetwork implements SocialNetwork {
  readonly name = "discord";
  /** The server the webhook's channel is in, read once, for links to the posts. */
  private guildId: string | null = null;

  constructor(
    /** https://discord.com/api/webhooks/<id>/<token> */
    private readonly webhookUrl: string,
    private readonly timeoutMs = 15_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async post(text: string) {
    const guild = await this.guild();
    const res = await this.fetcher(`${this.webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, MAX_CONTENT), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as { id?: string; channel_id?: string; retry_after?: number; message?: string } | null;
    if (res.status === 429) {
      const after = Number(body?.retry_after ?? res.headers.get("retry-after"));
      throw new NetworkBusy(Number.isFinite(after) && after > 0 ? Math.ceil(Date.now() / 1000 + after) : null);
    }
    if (!res.ok || !body?.id) throw new Error(`Discord refused the post (${res.status}): ${body?.message ?? "no detail"}`);
    return { id: body.id, url: `https://discord.com/channels/${guild}/${body.channel_id}/${body.id}` };
  }

  private async guild(): Promise<string> {
    if (this.guildId) return this.guildId;
    const res = await this.fetcher(this.webhookUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
    const body = (await res.json().catch(() => null)) as { guild_id?: string; message?: string } | null;
    if (!res.ok || !body?.guild_id) throw new Error(`Discord did not describe the webhook (${res.status}): ${body?.message ?? "no detail"}`);
    this.guildId = body.guild_id;
    return this.guildId;
  }
}
