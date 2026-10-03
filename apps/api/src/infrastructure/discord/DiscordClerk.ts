import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { AskManual, ChatAnswer } from "../../application/askManual";
import type { Logger } from "../../application/ports/logger";
import { MANUAL_LOCALES, type ManualLocale } from "../../domain/manual";

/**
 * The manual's chatbot on Discord: the `/ask` slash command, served over HTTP (Discord posts
 * each use of the command to the API, signed with the application's Ed25519 key). Discord wants
 * an answer within 3 seconds and the model takes longer, so the clerk first says it is looking
 * ("deferred"), then edits that message with the answer.
 */

const API = "https://discord.com/api/v10";
/** Discord's limit on a message's text. */
const MAX_CONTENT = 2000;

/** Interaction and response types, and the message flag that shows a reply to its asker only. */
const PING = 1;
const COMMAND = 2;
const PONG = 1;
const MESSAGE = 4;
const DEFERRED = 5;
const EPHEMERAL = 64;

/** `/ask`, registered once with `pnpm --filter @dno/api discord:commands`. */
export const ASK_COMMAND = {
  name: "ask",
  type: 1,
  description: "Ask the depot clerk how DO NOT OPEN works. Answers from the manual only.",
  description_localizations: {
    fr: "Demande au guichetier comment marche DO NOT OPEN. Il répond d'après le manuel.",
    "es-ES": "Pregunta al empleado cómo funciona DO NOT OPEN. Responde solo con el manual.",
    "es-419": "Pregunta al empleado cómo funciona DO NOT OPEN. Responde solo con el manual.",
    it: "Chiedi all'impiegato come funziona DO NOT OPEN. Risponde solo dal manuale.",
  },
  options: [
    {
      name: "question",
      type: 3,
      required: true,
      max_length: 500,
      description: "Your question, in English, French, Spanish or Italian.",
      name_localizations: { fr: "question", "es-ES": "pregunta", "es-419": "pregunta", it: "domanda" },
      description_localizations: {
        fr: "Ta question, en français, anglais, espagnol ou italien.",
        "es-ES": "Tu pregunta, en español, inglés, francés o italiano.",
        "es-419": "Tu pregunta, en español, inglés, francés o italiano.",
        it: "La tua domanda, in italiano, inglese, francese o spagnolo.",
      },
    },
    {
      name: "private",
      type: 5,
      required: false,
      description: "Only you see the answer.",
      name_localizations: { fr: "privé", "es-ES": "privado", "es-419": "privado", it: "privato" },
      description_localizations: { fr: "Toi seul vois la réponse.", "es-ES": "Solo tú ves la respuesta.", "es-419": "Solo tú ves la respuesta.", it: "Solo tu vedi la risposta." },
    },
  ],
  // In servers and in the bot's direct messages.
  contexts: [0, 1],
  integration_types: [0],
} as const;

const WORDS: Record<ManualLocale, { away: string; nothing: string; failed: string; unknown: string }> = {
  en: {
    away: "The clerk is away from the desk. Here is what the manual says:",
    nothing: "The manual has nothing on that.",
    failed: "The clerk dropped the file. Try again in a minute.",
    unknown: "The depot only knows /ask.",
  },
  fr: {
    away: "Le guichetier s'est absenté. Voici ce que dit le manuel :",
    nothing: "Le manuel ne dit rien là-dessus.",
    failed: "Le guichetier a fait tomber le dossier. Réessaie dans une minute.",
    unknown: "Le dépôt ne connaît que /ask.",
  },
  es: {
    away: "El empleado no está en el mostrador. Esto dice el manual:",
    nothing: "El manual no dice nada de eso.",
    failed: "Al empleado se le cayó el expediente. Prueba de nuevo en un minuto.",
    unknown: "El depósito solo conoce /ask.",
  },
  it: {
    away: "L'impiegato non è allo sportello. Ecco cosa dice il manuale:",
    nothing: "Il manuale non dice nulla su questo.",
    failed: "All'impiegato è caduta la pratica. Riprova tra un minuto.",
    unknown: "Il deposito conosce solo /ask.",
  },
};

/** Discord's locale ("fr", "en-US", "es-419") to the manual's language. */
export function localeOf(discord: string | undefined): ManualLocale {
  const lang = (discord ?? "").slice(0, 2).toLowerCase();
  return (MANUAL_LOCALES as readonly string[]).includes(lang) ? (lang as ManualLocale) : "en";
}

/** Whether Discord signed this request: Ed25519 over the timestamp header then the raw body. */
export function signedByDiscord(publicKeyHex: string, signatureHex: string, timestamp: string, body: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
  // A raw Ed25519 key wrapped in its SubjectPublicKeyInfo header, the form node:crypto reads.
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
  return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signatureHex, "hex"));
}

const interaction = z.object({
  type: z.number(),
  token: z.string().optional(),
  locale: z.string().optional(),
  member: z.object({ user: z.object({ id: z.string() }) }).optional(),
  user: z.object({ id: z.string() }).optional(),
  data: z
    .object({
      name: z.string(),
      options: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
    })
    .optional(),
});

/** "> question", then the answer or the manual's passages, then links to the sections, within Discord's limit. */
export function clerkReply(question: string, a: ChatAnswer, locale: ManualLocale, manualUrl: string | null): string {
  const words = WORDS[locale];
  const quote = question.trim().slice(0, 300).split("\n").map((l) => `> ${l}`).join("\n");
  const links = a.sources.map((s) => (manualUrl ? `[${s.title}](<${manualUrl}#${s.section}>)` : s.title)).join(" · ");
  const footer = links ? `\n\n📖 ${links}` : "";
  let body: string;
  if (a.mode === "ai") body = a.answer ?? "";
  else if (a.passages.length === 0) body = words.nothing;
  else body = [words.away, ...a.passages.map((p) => `**${p.heading ?? p.title}**: ${p.text}`)].join("\n\n");
  const room = MAX_CONTENT - quote.length - footer.length - 2;
  if (body.length > room) body = `${body.slice(0, room - 1).trimEnd()}…`;
  return `${quote}\n\n${body}${footer}`;
}

export interface DiscordClerkOptions {
  applicationId: string;
  /** The manual page, e.g. https://<site>/docs.html: sections are linked. Without it, named only. */
  manualUrl: string | null;
}

export class DiscordClerk {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly chat: AskManual,
    private readonly opts: DiscordClerkOptions,
    private readonly log: Logger,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  /** The immediate response to an interaction; an `/ask` is answered afterwards, by editing it. */
  respond(body: unknown): object {
    const i = interaction.parse(body);
    if (i.type === PING) return { type: PONG };
    const locale = localeOf(i.locale);
    if (i.type !== COMMAND || i.data?.name !== ASK_COMMAND.name || !i.token) {
      return { type: MESSAGE, data: { content: WORDS[locale].unknown, flags: EPHEMERAL } };
    }
    const option = (name: string) => i.data?.options?.find((o) => o.name === name)?.value;
    const question = String(option("question") ?? "").trim();
    const user = i.member?.user.id ?? i.user?.id ?? "unknown";
    const task = this.answer(i.token, question, locale, user).finally(() => this.pending.delete(task));
    this.pending.add(task);
    return { type: DEFERRED, data: option("private") === true ? { flags: EPHEMERAL } : {} };
  }

  /** Resolves when every answer under way has been sent: for tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async answer(token: string, question: string, locale: ManualLocale, user: string): Promise<void> {
    let content: string;
    try {
      // The chat's daily limits count per Discord user, as they count per IP on the site.
      const a = await this.chat.ask({ question: question.slice(0, 500), locale, history: [] }, `discord:${user}`);
      content = clerkReply(question, a, locale, this.opts.manualUrl);
    } catch (error) {
      this.log.warn({ err: (error as Error).message }, "discord clerk could not answer");
      content = WORDS[locale].failed;
    }
    try {
      const res = await this.fetcher(`${API}/webhooks/${this.opts.applicationId}/${token}/messages/@original`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) this.log.warn({ status: res.status, body: await res.text().catch(() => "") }, "discord refused the clerk's answer");
    } catch (error) {
      this.log.warn({ err: (error as Error).message }, "discord clerk could not send its answer");
    }
  }
}
