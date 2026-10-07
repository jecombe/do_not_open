import type { Locale } from "../i18n/locale";
import { docsPath } from "../site";
import { apiUrl } from "../apiUrl";

/** What the API's /v1/chat answers: see apps/api/src/application/askManual.ts. */
export interface ClerkAnswer {
  mode: "ai" | "passages";
  answer: string | null;
  sources: { section: string; title: string }[];
  passages: { section: string; title: string; heading: string | null; text: string }[];
  reason: "no-model" | "unavailable" | "limit" | null;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** The API, when this build has one. The chat needs it: the model's key never reaches the browser. */
export const chatApi = (): string | null => apiUrl();

export class ClerkError extends Error {
  constructor(readonly kind: "busy" | "network") {
    super(kind);
  }
}

export async function askClerk(question: string, locale: Locale, history: Turn[], signal?: AbortSignal): Promise<ClerkAnswer> {
  const api = chatApi();
  if (!api) throw new ClerkError("network");
  let res: Response;
  try {
    res = await fetch(`${api}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, locale, history }),
      signal,
    });
  } catch {
    throw new ClerkError("network");
  }
  if (res.status === 429) throw new ClerkError("busy");
  if (!res.ok) throw new ClerkError("network");
  return ((await res.json()) as { data: ClerkAnswer }).data;
}

/** A link to a section of the manual, in the reader's language. */
export const manualLink = (section: string, locale: Locale) => `${docsPath(locale)}#${section}`;
