import { appPath } from "../site";

/** Where a box can be sent, and how each network wants a post handed to it. */
export type Network = "x" | "farcaster" | "bluesky" | "telegram" | "whatsapp" | "reddit";

export const NETWORKS: readonly { key: Network; name: string }[] = [
  { key: "x", name: "X" },
  { key: "farcaster", name: "Farcaster" },
  { key: "bluesky", name: "Bluesky" },
  { key: "telegram", name: "Telegram" },
  { key: "whatsapp", name: "WhatsApp" },
  { key: "reddit", name: "Reddit" },
];

const TAGS = "#DoNotOpen";
const q = encodeURIComponent;

/** The networks that live on hashtags get one; chat apps do not. */
export function intentUrl(network: Network, text: string, url: string): string {
  switch (network) {
    case "x":
      return `https://x.com/intent/post?text=${q(`${text} ${TAGS}`)}&url=${q(url)}`;
    case "farcaster":
      return `https://farcaster.xyz/~/compose?text=${q(`${text} ${TAGS}`)}&embeds[]=${q(url)}`;
    case "bluesky":
      // Bluesky takes no separate link: it turns the one in the text into a card.
      return `https://bsky.app/intent/compose?text=${q(`${text} ${TAGS}\n${url}`)}`;
    case "telegram":
      return `https://t.me/share/url?url=${q(url)}&text=${q(text)}`;
    case "whatsapp":
      return `https://wa.me/?text=${q(`${text}\n${url}`)}`;
    case "reddit":
      return `https://www.reddit.com/submit?url=${q(url)}&title=${q(text)}`;
  }
}

/**
 * The link that opens the app straight on one box. A forced chain (`?chain=`) travels with
 * it, so the link lands on the same boxes; the language does not: whoever clicks gets theirs.
 */
export function boxUrl(tokenId: number): string {
  const url = new URL(appPath("en"), window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("box", String(tokenId));
  const chain = new URLSearchParams(window.location.search).get("chain");
  if (chain) url.searchParams.set("chain", chain);
  return url.toString();
}

/** Whether this browser can hand a picture to another app (a phone's share sheet). */
export const canShareFiles = (file: File) => {
  try {
    return !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
};

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function download(file: File) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
