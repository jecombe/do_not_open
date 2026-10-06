import type { XSignIn } from "../../application/xPass";

/**
 * Sign in with X: OAuth 2.0, authorization code with PKCE, as a confidential client. The scopes
 * only read who the player is (`users/me`); nothing is posted for them, and no token is kept.
 */
export class XOAuth implements XSignIn {
  constructor(
    private readonly o: { clientId: string; clientSecret?: string; redirectUri: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  authorizeUrl(state: string, challenge: string): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      scope: "tweet.read users.read",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `https://x.com/i/oauth2/authorize?${q}`;
  }

  async account(code: string, verifier: string): Promise<{ id: string; username: string }> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.o.clientSecret) headers.authorization = `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString("base64")}`;
    const token = await this.fetchFn("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers,
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.o.redirectUri, code_verifier: verifier, client_id: this.o.clientId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!token.ok) throw new Error(`X token ${token.status}`);
    const { access_token } = (await token.json()) as { access_token?: string };
    if (!access_token) throw new Error("X token: no access token");
    const me = await this.fetchFn("https://api.x.com/2/users/me", { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
    if (!me.ok) throw new Error(`X users/me ${me.status}`);
    const { data } = (await me.json()) as { data?: { id?: string; username?: string } };
    if (!data?.id || !data.username) throw new Error("X users/me: no account");
    return { id: data.id, username: data.username };
  }
}
