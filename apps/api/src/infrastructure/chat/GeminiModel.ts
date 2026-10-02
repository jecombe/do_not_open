import { ModelUnavailable, type AnswerModel, type AnswerRequest, type ModelAnswer } from "../../application/askManual";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

/** What the answer must look like: the text and the manual sections it used. */
const SCHEMA = {
  type: "OBJECT",
  properties: {
    answer: { type: "STRING" },
    sections: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["answer", "sections"],
};

export interface GeminiOptions {
  apiKey: string;
  /** Tried in order: a model that is busy, over its quota or failing hands over to the next. */
  models: string[];
  timeoutMs: number;
  fetch?: typeof fetch;
  log?: { warn(obj: object, msg: string): void };
}

/**
 * Google's Gemini API, on its free tier. The key stays on this server: browsers only ever
 * talk to the API. Errors that mean "not now" (rate limits, overload, timeouts) become
 * `ModelUnavailable`, so the chat falls back on the manual's own paragraphs.
 */
export class GeminiModel implements AnswerModel {
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: GeminiOptions) {
    if (opts.models.length === 0) throw new Error("GeminiModel needs at least one model");
    this.fetch = opts.fetch ?? fetch;
  }

  async answer(request: AnswerRequest): Promise<ModelAnswer> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: `${request.instructions}\n\nTHE MANUAL:\n${request.manual}` }] },
      contents: [
        ...request.history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
        { role: "user", parts: [{ text: request.question }] },
      ],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: "application/json", responseSchema: SCHEMA },
    });
    let last = "no model tried";
    for (const model of this.opts.models) {
      try {
        return await this.ask(model, body);
      } catch (error) {
        if (!(error instanceof ModelUnavailable)) throw error;
        last = `${model}: ${error.message}`;
        this.opts.log?.warn({ model, reason: error.message }, "gemini model unavailable, trying the next");
      }
    }
    throw new ModelUnavailable(last);
  }

  private async ask(model: string, body: string): Promise<ModelAnswer> {
    let res: Response;
    try {
      res = await this.fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (error) {
      throw new ModelUnavailable(error instanceof Error ? error.message : "network error");
    }
    const json = (await res.json().catch(() => null)) as GeminiResponse | null;
    // 429: quota; 5xx: overloaded or failing; 404: the model is gone. All mean "try another".
    if (!res.ok) throw new ModelUnavailable(`HTTP ${res.status}${json?.error?.message ? `: ${json.error.message.slice(0, 160)}` : ""}`);
    const candidate = json?.candidates?.[0];
    const text = candidate?.content?.parts?.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("") ?? "";
    if (!text) throw new ModelUnavailable(`empty answer (${candidate?.finishReason ?? json?.promptFeedback?.blockReason ?? "no candidate"})`);
    let parsed: { answer?: unknown; sections?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ModelUnavailable("the answer was not JSON");
    }
    if (typeof parsed.answer !== "string" || !parsed.answer.trim()) throw new ModelUnavailable("the answer had no text");
    const sections = Array.isArray(parsed.sections) ? parsed.sections.filter((s): s is string => typeof s === "string") : [];
    return { text: parsed.answer.trim(), sections: sections.map((s) => s.replace(/^\[|\]$/g, "").trim()).slice(0, 3) };
  }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}
