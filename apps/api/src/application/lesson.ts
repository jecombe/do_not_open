import type { Draft } from "../domain/herald";
import { lessonBudget, lessonDraft, lessonInstructions, lessonProblem, lessonSource, quotedLesson, syllabus, topicOf, type Topic } from "../domain/lesson";
import type { Manual } from "../domain/manual";
import type { AnswerModel } from "./askManual";
import type { Logger } from "./ports/logger";

export interface LessonOptions {
  /** The manual page, e.g. "https://donotopen.xyz/docs.html": each lesson links to its section. Without it, no link. */
  manualUrl: string | null;
  /** Posts asked of the model before quoting the manual instead. */
  tries: number;
}

/**
 * Writes the day's lesson for the herald: the model words one passage of the manual, and what
 * it writes goes out only if it passes `lessonProblem`. Without a model, or when every try
 * fails, the passage itself is quoted. Never throws: a lesson always comes out.
 */
export class LessonWriter {
  private readonly topics: Topic[];

  constructor(
    manual: Manual,
    private readonly model: AnswerModel | null,
    private readonly opts: LessonOptions,
    private readonly log: Logger,
  ) {
    this.topics = syllabus(manual);
  }

  async write(day: string): Promise<Draft | null> {
    const topic = topicOf(this.topics, day);
    if (!topic) return null;
    const link = this.opts.manualUrl ? `${this.opts.manualUrl}#${topic.section.id}` : null;
    const budget = lessonBudget(link);
    for (let attempt = 1; this.model && attempt <= this.opts.tries; attempt++) {
      try {
        const { text } = await this.model.answer({
          instructions: lessonInstructions(budget),
          manual: lessonSource(topic),
          history: [],
          question: attempt === 1 ? "Write today's post." : "Write today's post again, shorter and closer to the text.",
        });
        const problem = lessonProblem(text, topic, budget);
        if (!problem) return lessonDraft(day, text, link);
        this.log.warn({ day, passage: topic.passage.id, attempt, problem, text }, "lesson refused, asking again");
      } catch (error) {
        this.log.warn({ day, passage: topic.passage.id, attempt, err: (error as Error).message }, "lesson model failed");
      }
    }
    return quotedLesson(day, topic, link);
  }
}
