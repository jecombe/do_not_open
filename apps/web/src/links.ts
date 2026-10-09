/** The code, open source. */
export const REPO = "https://github.com/jecombe/do_not_open";

/** The contracts, with their tests and deployed addresses, published from the main repository. */
export const SOURCE = "https://gitlab.com/do-not-open";
export const SOURCE_GAME = `${SOURCE}/do-not-open-game`;
export const SOURCE_VAULT = `${SOURCE}/do-not-open-vault`;

/** The collection's Discord server, linked from the home page and the game's footer. */
export const DISCORD = "https://discord.gg/vYSzwM8Rmn";

/** The collection's X account: following it is the first step to the mainnet list. */
export const X_HANDLE = "do_not_open_box";
export const X_FOLLOW = `https://x.com/intent/follow?screen_name=${X_HANDLE}`;
/** X's post composer, filled in: works without any key, in a new tab. */
export const xPost = (text: string, url: string): string => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

/** The announcement post on X that players like, reply to and repost. Empty until it is posted:
 *  those three tasks then wait. Only the id, the digits at the end of the post's link. */
export const ANNOUNCEMENT_TWEET_ID = "";
export const announcementLinks = (id: string) => ({
  post: `https://x.com/${X_HANDLE}/status/${id}`,
  like: `https://x.com/intent/like?tweet_id=${id}`,
  reply: `https://x.com/intent/post?in_reply_to=${id}`,
  repost: `https://x.com/intent/retweet?tweet_id=${id}`,
});
