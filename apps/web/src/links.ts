/** The code, open source. */
export const REPO = "https://github.com/jecombe/do_not_open";

/** The collection's Discord server, linked from the home page and the game's footer. */
export const DISCORD = "https://discord.gg/vYSzwM8Rmn";

/** The Galxe quest (follow, like, repost, three questions). Empty until it is published: the
 *  home page then shows the step as coming soon. */
export const GALXE_QUEST = "";

/** The collection's X account: following it is the first step to the mainnet list. */
export const X_HANDLE = "do_not_open_box";
export const X_FOLLOW = `https://x.com/intent/follow?screen_name=${X_HANDLE}`;
/** X's post composer, filled in: works without any key, in a new tab. */
export const xPost = (text: string, url: string): string => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
