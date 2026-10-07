import type { Address } from "../domain/types";
import type { XTask } from "./xPass";

/**
 * What players do on the boarding page and the whitelist, told to the team's private channel as
 * it happens. Handles are public on X; a wallet is shown only for a claim with no pass behind it,
 * shortened, and never next to a handle: the link between the two stays in the database.
 */
export type Activity =
  | { kind: "x-connected"; handle: string; via: "sign-in" | "post"; code: string }
  | { kind: "task"; handle: string | null; code: string; task: XTask }
  | { kind: "seated"; handle: string | null; code: string }
  | { kind: "wallet"; handle: string; code: string }
  | { kind: "discord"; handle: string | null; code: string }
  | { kind: "claim"; handle: string | null; address: Address }
  | { kind: "idea"; handle: string | null; text: string; locale: string };

/** Where activity goes. `tell` returns at once and never throws: a player never waits on it. */
export interface ActivityFeed {
  tell(activity: Activity): void;
}

export const noActivityFeed: ActivityFeed = { tell() {} };

const TASK_LABEL: Record<XTask, string> = { follow: "followed the account", post: "posted the boarding tweet", like: "liked the announcement", reply: "replied to the announcement", repost: "reposted the announcement" };

/** `@handle` linked to the X profile (no embed), or the pass code when no account is connected yet. */
const who = (handle: string | null, code?: string) => (handle ? `[@${handle}](<https://x.com/${handle}>)` : code ? `pass ${code} (no X yet)` : "someone without a pass");

const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The message the channel shows. */
export function activityText(a: Activity): string {
  switch (a.kind) {
    case "x-connected":
      return `𝕏 ${who(a.handle)} connected X on a boarding pass (${a.via === "sign-in" ? "Sign in with X" : "a post with the code"}).`;
    case "task":
      return `✅ ${who(a.handle, a.code)} ${TASK_LABEL[a.task]}.`;
    case "seated":
      return `💺 ${who(a.handle, a.code)} did every task and took a seat on the whitelist.`;
    case "wallet":
      return `👛 ${who(a.handle)} linked a wallet to their pass.`;
    case "discord":
      return `🎮 ${who(a.handle, a.code)} joined the Discord server and ran /board.`;
    case "claim":
      return `✍️ ${a.handle ? who(a.handle) : short(a.address)} claimed a place on the whitelist.`;
    case "idea": {
      const text = a.text.length > 500 ? `${a.text.slice(0, 500)}…` : a.text;
      return `💡 ${who(a.handle)} left an idea (${a.locale}):\n> ${text}`;
    }
  }
}
