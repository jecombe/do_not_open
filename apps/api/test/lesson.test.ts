import { beforeEach, describe, expect, it } from "vitest";
import { ModelUnavailable, type AnswerModel, type AnswerRequest } from "../src/application/askManual";
import { Herald } from "../src/application/herald";
import { LessonWriter } from "../src/application/lesson";
import type { SocialNetwork } from "../src/application/ports/herald";
import { silentLogger } from "../src/application/ports/logger";
import { MAX_POST } from "../src/domain/herald";
import { lessonBudget, lessonProblem, postLength, quotedLesson, syllabus, topicOf } from "../src/domain/lesson";
import manualJson from "../src/infrastructure/chat/manual.json";
import { MemoryStore } from "../src/infrastructure/memory/MemoryStore";
import { ev } from "./fixtures";

const manual = manualJson.locales.en;
const topics = syllabus(manual);
const LINK = "https://dno.test/docs.html";

/** A model that answers from a list, then throws. */
class ScriptedModel implements AnswerModel {
  asked: AnswerRequest[] = [];
  constructor(private readonly replies: (string | Error)[]) {}
  async answer(request: AnswerRequest) {
    this.asked.push(request);
    const next = this.replies.shift() ?? new ModelUnavailable("no more");
    if (next instanceof Error) throw next;
    return { text: next, sections: [] };
  }
}

describe("the syllabus", () => {
  it("teaches every passage of the players' manual, never the release form, the testnet or the dev part", () => {
    const sections = new Set(topics.map((t) => t.section.id));
    expect(sections.has("terms")).toBe(false);
    expect(sections.has("testnet")).toBe(false);
    expect(sections.has("code")).toBe(false);
    expect(topics.length).toBe(manual.passages.filter((p) => [...sections].includes(p.section)).length);
    expect(topics.length).toBeGreaterThan(20);
  });

  it("moves to another section from one day to the next, and loops", () => {
    const a = topicOf(topics, "2026-10-03")!;
    const b = topicOf(topics, "2026-10-04")!;
    expect(a.section.id).not.toBe(b.section.id);
    const later = new Date(Date.parse("2026-10-03") + topics.length * 86_400_000).toISOString().slice(0, 10);
    expect(topicOf(topics, later)!.passage.id).toBe(a.passage.id);
  });
});

describe("what a lesson may say", () => {
  const fees = topics.find((t) => t.passage.id === "fees-1")!;
  const budget = lessonBudget(LINK);

  it("lets a post through when its numbers are the manual's", () => {
    expect(lessonProblem("💸 Shaking someone else's box costs 2.5 USDC, and 70% of it goes to whoever holds the box. They never learn who shook it.", fees, budget)).toBeNull();
  });

  it("refuses a number the manual does not have, a link, a hashtag, a forbidden word, or a long post", () => {
    expect(lessonProblem("💸 A shake costs 3 USDC.", fees, budget)).toMatch(/numbers not in the manual: 3/);
    expect(lessonProblem("💸 See https://evil.test", fees, budget)).toBe("a link");
    expect(lessonProblem("💸 Shake a box #NFT", fees, budget)).toBe("a hashtag or a mention");
    expect(lessonProblem("💸 Fully anonymous shaking.", fees, budget)).toMatch(/forbidden/);
    expect(lessonProblem("💸 A great investment.", fees, budget)).toMatch(/forbidden/);
    expect(lessonProblem("x".repeat(budget + 1), fees, budget)).toMatch(/too long/);
    expect(lessonProblem("Send it to 0xabcdef1234", fees, budget)).toBe("an address");
  });

  it("counts an emoji as two", () => {
    expect(postLength("📦a")).toBe(3);
  });

  it("quotes the manual within the limit when it has to, never a table row", () => {
    for (const t of topics) {
      const d = quotedLesson("2026-10-03", t, `${LINK}#${t.section.id}`);
      expect(postLength(d.text.slice(0, d.text.lastIndexOf("\n")))).toBeLessThanOrEqual(MAX_POST - 24);
      expect(d.text).toContain(`${LINK}#${t.section.id}`);
      expect(d.text).not.toContain(" | ");
    }
  });
});

describe("the lesson writer", () => {
  const day = "2026-10-03";
  const topic = topicOf(topics, day)!;

  it("posts the model's words with a link to the section", async () => {
    const model = new ScriptedModel(["📦 Nobody can see who holds a box."]);
    const d = (await new LessonWriter(manual, model, { manualUrl: LINK, tries: 2 }, silentLogger).write(day))!;
    expect(d).toEqual({ key: `lesson:${day}`, kind: "lesson", text: `📦 Nobody can see who holds a box.\n${LINK}#${topic.section.id}` });
    expect(model.asked[0]!.manual).toContain(topic.passage.text);
  });

  it("asks again when the first post fails the checks, then quotes the manual", async () => {
    const model = new ScriptedModel(["📦 Boxes cost 999,999 USDC.", "📦 Still 123456789 of them."]);
    const d = (await new LessonWriter(manual, model, { manualUrl: null, tries: 2 }, silentLogger).write(day))!;
    expect(model.asked).toHaveLength(2);
    expect(d.text.startsWith(`📖 ${topic.section.title}\n“`)).toBe(true);
  });

  it("quotes the manual without a model, or when it is down", async () => {
    const quoted = quotedLesson(day, topic, null);
    expect(await new LessonWriter(manual, null, { manualUrl: null, tries: 2 }, silentLogger).write(day)).toEqual(quoted);
    const down = new ScriptedModel([new ModelUnavailable("429"), new Error("boom")]);
    expect(await new LessonWriter(manual, down, { manualUrl: null, tries: 2 }, silentLogger).write(day)).toEqual(quoted);
  });
});

describe("the herald's lesson", () => {
  let store: MemoryStore;
  let sent: string[];
  const network: SocialNetwork = { name: "x", post: async (text) => (sent.push(text), { id: "1", url: "https://x.com/dno/status/1" }) };
  // 2027-01-15 08:00 UTC.
  let now = Date.parse("2027-01-15T08:00:00Z") / 1000;
  const herald = (writer: LessonWriter) =>
    new Herald(store, network, { maxPerDay: 12, minGapSeconds: 0, digestHourUtc: null, staleAfterSeconds: 86_400, batch: 100, maxAttempts: 2, lesson: { hourUtc: 14, writer } }, silentLogger, () => now);

  beforeEach(async () => {
    store = new MemoryStore();
    sent = [];
    now = Date.parse("2027-01-15T08:00:00Z") / 1000;
    await store.transaction(async (tx) => {
      await tx.insertEvent(ev("Fed", 10, { tokenId: 1, feeder: "0x0000000000000000000000000000000000000001" }), null);
      await tx.setCursor(10);
    });
  });

  it("writes one lesson a day, once its hour has come", async () => {
    const model = new ScriptedModel(["📦 One.", "📦 Two."]);
    const writer = new LessonWriter(manual, model, { manualUrl: null, tries: 1 }, silentLogger);
    await herald(writer).run(); // first run: starts from the present
    await herald(writer).run();
    expect(sent).toEqual([]);
    now += 7 * 3600; // 15:00
    await herald(writer).run();
    await herald(writer).run();
    expect(sent).toEqual(["📦 One."]);
    expect(model.asked).toHaveLength(1);
    now += 86_400;
    await herald(writer).run();
    expect(sent).toEqual(["📦 One.", "📦 Two."]);
    expect((await store.posts(10)).map((p) => p.key)).toEqual(["lesson:2027-01-16", "lesson:2027-01-15"]);
  });
});
