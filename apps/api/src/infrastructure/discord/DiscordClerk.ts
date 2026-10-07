import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { AskManual, ChatAnswer } from "../../application/askManual";
import type { Logger } from "../../application/ports/logger";
import type { DiscordBoarding } from "../../application/xPass";
import { MANUAL_LOCALES, type ManualLocale } from "../../domain/manual";

/**
 * The manual's chatbot on Discord: the `/ask` slash command, served over HTTP (Discord posts
 * each use of the command to the API, signed with the application's Ed25519 key). Discord wants
 * an answer within 3 seconds and the model takes longer, so the clerk first says it is looking
 * ("deferred"), then edits that message with the answer. Both are ephemeral: only the asker sees
 * the question and the answer, so a public channel never fills with other players' questions.
 *
 * `/board <code>` ties the Discord account that runs it to a boarding pass on the site, which
 * adds points to the pass's wallet. Discord says who ran it and in which server: that is the proof.
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
  ],
  // In servers and in the bot's direct messages.
  contexts: [0, 1],
  integration_types: [0],
} as const;

/** `/board`, registered with `/ask`: the one-time code the boarding page shows. */
export const BOARD_COMMAND = {
  name: "board",
  type: 1,
  description: "Join the DO NOT OPEN whitelist from Discord with the code from the boarding page.",
  description_localizations: {
    fr: "Rejoins la whitelist de DO NOT OPEN depuis Discord avec le code de la page d'embarquement.",
    "es-ES": "Únete a la whitelist de DO NOT OPEN desde Discord con el código de la página de embarque.",
    "es-419": "Únete a la whitelist de DO NOT OPEN desde Discord con el código de la página de embarque.",
    it: "Entra nella whitelist di DO NOT OPEN da Discord con il codice della pagina d'imbarco.",
  },
  options: [
    {
      name: "code",
      type: 3,
      required: true,
      max_length: 20,
      description: "The code the boarding page shows, like DNO-AB12CD.",
      name_localizations: { fr: "code", "es-ES": "codigo", "es-419": "codigo", it: "codice" },
      description_localizations: {
        fr: "Le code affiché sur la page d'embarquement, comme DNO-AB12CD.",
        "es-ES": "El código que muestra la página de embarque, como DNO-AB12CD.",
        "es-419": "El código que muestra la página de embarque, como DNO-AB12CD.",
        it: "Il codice mostrato nella pagina d'imbarco, come DNO-AB12CD.",
      },
    },
  ],
  // In servers only: the server is what is proved.
  contexts: [0],
  integration_types: [0],
} as const;

const BOARD_WORDS: Record<ManualLocale, Record<DiscordBoarding, string>> = {
  en: {
    ok: "✅ You're on board: your Discord counts {bonus} points on the whitelist once your wallet is linked to your pass. Stay in the server: the team checks before mainnet.",
    already: "✅ This Discord account is already on that pass.",
    "unknown-code": "That code is unknown or expired. Ask the boarding page for a new one.",
    "too-young": "This Discord account is too new to board. Accounts must be at least 30 days old.",
    "wrong-server": "Run /board in the DO NOT OPEN server.",
    off: "Boarding from Discord is closed for now.",
  },
  fr: {
    ok: "✅ C'est bon : ton Discord compte {bonus} points sur la whitelist une fois ton wallet lié à ton pass. Reste dans le serveur : l'équipe vérifie avant le mainnet.",
    already: "✅ Ce compte Discord est déjà sur ce pass.",
    "unknown-code": "Ce code est inconnu ou a expiré. Demandes-en un nouveau sur la page d'embarquement.",
    "too-young": "Ce compte Discord est trop récent pour embarquer. Il doit avoir au moins 30 jours.",
    "wrong-server": "Lance /board dans le serveur DO NOT OPEN.",
    off: "L'embarquement depuis Discord est fermé pour l'instant.",
  },
  es: {
    ok: "✅ Ya estás a bordo: tu Discord suma {bonus} puntos en la whitelist en cuanto tu wallet esté vinculada a tu pase. Quédate en el servidor: el equipo lo revisa antes de mainnet.",
    already: "✅ Esta cuenta de Discord ya está en ese pase.",
    "unknown-code": "Ese código no existe o caducó. Pide uno nuevo en la página de embarque.",
    "too-young": "Esta cuenta de Discord es demasiado nueva para embarcar. Debe tener al menos 30 días.",
    "wrong-server": "Usa /board en el servidor de DO NOT OPEN.",
    off: "El embarque desde Discord está cerrado por ahora.",
  },
  it: {
    ok: "✅ Sei a bordo: il tuo Discord vale {bonus} punti nella whitelist appena il tuo wallet è collegato al pass. Resta nel server: il team controlla prima della mainnet.",
    already: "✅ Questo account Discord è già su quel pass.",
    "unknown-code": "Codice sconosciuto o scaduto. Chiedine uno nuovo nella pagina d'imbarco.",
    "too-young": "Questo account Discord è troppo recente per imbarcarsi. Deve avere almeno 30 giorni.",
    "wrong-server": "Usa /board nel server di DO NOT OPEN.",
    off: "L'imbarco da Discord è chiuso per ora.",
  },
};

const WORDS: Record<ManualLocale, { away: string; nothing: string; failed: string; unknown: string }> = {
  en: {
    away: "The clerk is away from the desk. Here is what the manual says:",
    nothing: "The manual has nothing on that.",
    failed: "The clerk dropped the file. Try again in a minute.",
    unknown: "The depot only knows /ask and /board.",
  },
  fr: {
    away: "Le guichetier s'est absenté. Voici ce que dit le manuel :",
    nothing: "Le manuel ne dit rien là-dessus.",
    failed: "Le guichetier a fait tomber le dossier. Réessaie dans une minute.",
    unknown: "Le dépôt ne connaît que /ask et /board.",
  },
  es: {
    away: "El empleado no está en el mostrador. Esto dice el manual:",
    nothing: "El manual no dice nada de eso.",
    failed: "Al empleado se le cayó el expediente. Prueba de nuevo en un minuto.",
    unknown: "El depósito solo conoce /ask y /board.",
  },
  it: {
    away: "L'impiegato non è allo sportello. Ecco cosa dice il manuale:",
    nothing: "Il manuale non dice nulla su questo.",
    failed: "All'impiegato è caduta la pratica. Riprova tra un minuto.",
    unknown: "Il deposito conosce solo /ask e /board.",
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
  guild_id: z.string().optional(),
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
  /** Serves `/board` when set: ties the account that runs it to a boarding pass. */
  boarding?: { joinDiscord(code: string, member: { userId: string; guildId: string | null }): Promise<DiscordBoarding>; bonus: number };
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
    const user = i.member?.user.id ?? i.user?.id ?? "unknown";
    let task: Promise<void>;
    if (i.type === COMMAND && i.data?.name === ASK_COMMAND.name && i.token) {
      const question = String(i.data.options?.find((o) => o.name === "question")?.value ?? "").trim();
      task = this.answer(i.token, question, locale, user);
    } else if (i.type === COMMAND && i.data?.name === BOARD_COMMAND.name && i.token && this.opts.boarding) {
      const code = String(i.data.options?.find((o) => o.name === "code")?.value ?? "");
      // In a server, Discord sends the member; in a direct message, only the user and no server.
      task = this.board(i.token, code, locale, { userId: user, guildId: i.member ? (i.guild_id ?? null) : null });
    } else {
      return { type: MESSAGE, data: { content: WORDS[locale].unknown, flags: EPHEMERAL } };
    }
    const running = task.finally(() => this.pending.delete(running));
    this.pending.add(running);
    return { type: DEFERRED, data: { flags: EPHEMERAL } };
  }

  private async board(token: string, code: string, locale: ManualLocale, member: { userId: string; guildId: string | null }): Promise<void> {
    let content: string;
    try {
      const outcome = await this.opts.boarding!.joinDiscord(code, member);
      content = BOARD_WORDS[locale][outcome].replace("{bonus}", String(this.opts.boarding!.bonus));
    } catch (error) {
      this.log.warn({ err: (error as Error).message }, "discord clerk could not board");
      content = WORDS[locale].failed;
    }
    await this.send(token, content);
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
    await this.send(token, content);
  }

  /** Replaces the "thinking" message with the reply. */
  private async send(token: string, content: string): Promise<void> {
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
