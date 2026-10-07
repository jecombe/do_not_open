/**
 * The admin routes of the API (apps/api/src/infrastructure/http/admin.ts), on this site's own
 * origin. Their shapes mirror apps/api/src/application/insights.ts.
 */

export type XTask = "follow" | "post" | "like" | "reply" | "repost";

export interface Kpi {
  key: string;
  total: number;
  today: number;
  yesterday: number;
  last7: number;
  prev7: number;
  spark: number[];
}

export interface DayRow {
  day: string;
  [series: string]: number | string;
}

export interface FeedItem {
  at: number;
  kind: string;
  who: string | null;
  text: string;
}

export interface Dashboard {
  generatedAt: number;
  days: number;
  kpis: Kpi[];
  seats: { taken: number; places: number | null; required: XTask[]; perDay: number; daysToFull: number | null };
  funnel: { step: string; count: number }[];
  tasks: Record<XTask, number>;
  medianToSeat: number | null;
  boarding: DayRow[];
  chain: DayRow[];
  heatmap: number[][];
  ideasByLocale: Record<string, number>;
  recent: FeedItem[];
}

export interface PlayerRow {
  code: string;
  handle: string | null;
  createdAt: number;
  verifiedAt: number | null;
  tasks: Record<XTask, number | null>;
  seated: boolean;
  seatedAt: number | null;
  wallet: boolean;
  claimed: boolean;
  discord: boolean;
  tweetUrl: string | null;
  updatedAt: number;
}

export interface Idea {
  id: number;
  text: string;
  handle: string | null;
  locale: string;
  createdAt: number;
}

/** The session ended or never began: the app shows the sign-in page. */
export class SignedOut extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: "same-origin", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  if (res.status === 401) throw new SignedOut();
  if (res.status === 429) throw new Error("Trop d'essais : attends une minute.");
  if (!res.ok) throw new Error(`L'API a répondu ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  session: () => call<{ signedIn: boolean }>("/session"),
  login: (password: string) => call<{ signedIn: boolean }>("/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => call<{ signedIn: boolean }>("/logout", { method: "POST", body: "{}" }),
  dashboard: (days: number) => call<Dashboard>(`/dashboard?days=${days}`),
  players: () => call<PlayerRow[]>("/players"),
  wallet: (code: string) => call<{ address: string | null }>(`/players/${encodeURIComponent(code)}/wallet`),
  ideas: () => call<Idea[]>("/ideas"),
};
