import type { XTask } from "./api";

/** The dashboard's words, in one place. */

export const KPI_LABEL: Record<string, { label: string; hint: string }> = {
  passes: { label: "Cartes d'embarquement", hint: "passes créés" },
  x: { label: "Comptes X connectés", hint: "Sign in with X ou post" },
  seated: { label: "Places via X", hint: "toutes les tâches faites" },
  discord: { label: "Discord /board", hint: "comptes Discord liés" },
  claims: { label: "Claims whitelist", hint: "wallets qui ont signé" },
  ideas: { label: "Idées reçues", hint: "boîte à idées" },
  purchases: { label: "Achats de boxes", hint: "transactions de mint" },
  opened: { label: "Boxes ouvertes", hint: "chats révélés" },
  duels: { label: "Duels postés", hint: "sur l'étagère" },
  rats: { label: "Rats adoptés", hint: "mints de rats" },
  packs: { label: "Packs studio", hint: "achetés on-chain" },
  active: { label: "Wallets actifs", hint: "distincts / jour · total = record" },
  deposits: { label: "Dépôts", hint: "NFT mis dans le coffre" },
  listings: { label: "Mises en vente", hint: "annonces Seaport" },
  seaportSales: { label: "Ventes Seaport", hint: "boîtes vendues sur OpenSea" },
  privateSales: { label: "Ventes privées", hint: "réglées (prix chiffré)" },
  withdrawals: { label: "Retraits", hint: "NFT sortis du coffre" },
  requests: { label: "Demandes", hint: "retraits, annonces, claims envoyés" },
};

export const TASK_LABEL: Record<XTask, string> = {
  follow: "Follow",
  post: "Tweet d'embarquement",
  like: "Like",
  reply: "Réponse",
  repost: "Repost",
};

export function stepLabel(step: string): string {
  if (step.startsWith("task:")) return `Tâche : ${TASK_LABEL[step.slice(5) as XTask] ?? step.slice(5)}`;
  return (
    {
      pass: "Carte créée",
      x: "Compte X connecté",
      seated: "Place prise",
      wallet: "Wallet lié",
      claimed: "Claim whitelist",
      discord: "Discord /board",
    } as Record<string, string>
  )[step] ?? step;
}

export const FEED_ICON: Record<string, string> = {
  pass: "🎫",
  x: "𝕏",
  task: "✅",
  seated: "💺",
  discord: "🎮",
  claim: "✍️",
  idea: "💡",
  chain: "⛓️",
};

/** Series colours: the site's palette. */
export const C = {
  sodium: "#ffb454",
  spectral: "#7de3d0",
  red: "#ff6b5e",
  tape: "#d9c28a",
  kraft: "#b8895a",
  blue: "#9cc7f0",
  green: "#9cf09a",
  violet: "#c9a7ff",
  manifest: "#e9dfc8",
};
