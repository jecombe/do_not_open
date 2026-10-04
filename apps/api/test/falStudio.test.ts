import { describe, expect, it } from "vitest";
import { FalStudio } from "../src/infrastructure/studio/FalStudio";

/** fal's queue: submit, IN_QUEUE then COMPLETED, then the result. */
function queue(result: unknown, statuses = ["IN_QUEUE", "COMPLETED"]) {
  const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
    if (init.method === "POST") return Response.json({ request_id: "r1", status_url: "https://q/r1/status", response_url: "https://q/r1" });
    if (url.endsWith("/status")) return Response.json({ status: statuses.shift() });
    return Response.json(result);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const make = (fetch: typeof globalThis.fetch) =>
  new FalStudio({ apiKey: "secret", imageModel: "fal-ai/flux/schnell", modelModel: "fal-ai/trellis", timeoutMs: 5_000, pollMs: 1, queueUrl: "https://queue.test", fetch });

describe("FalStudio", () => {
  it("queues a sketch, waits for it, and reads its picture", async () => {
    const { calls, fetch } = queue({ images: [{ url: "https://fal.media/a.png" }], has_nsfw_concepts: [false] });
    expect(await make(fetch).sketch("a styled cat")).toEqual({ url: "https://fal.media/a.png" });
    expect(calls[0]).toEqual({
      url: "https://queue.test/fal-ai/flux/schnell",
      method: "POST",
      auth: "Key secret",
      body: { prompt: "a styled cat", image_size: "square_hd", num_images: 1, enable_safety_checker: true, output_format: "jpeg" },
    });
    expect(calls.map((c) => c.url)).toEqual(["https://queue.test/fal-ai/flux/schnell", "https://q/r1/status", "https://q/r1/status", "https://q/r1"]);
  });

  it("turns a picture into a mesh, under either output name", async () => {
    expect(await make(queue({ model_mesh: { url: "https://fal.media/a.glb" } }).fetch).model("https://fal.media/a.png")).toEqual({ url: "https://fal.media/a.glb" });
    expect(await make(queue({ model_glb: { url: "https://fal.media/b.glb" } }).fetch).model("https://fal.media/a.png")).toEqual({ url: "https://fal.media/b.glb" });
  });

  it("fails on a flagged picture, a failed request, and an empty result", async () => {
    await expect(make(queue({ images: [{ url: "x" }], has_nsfw_concepts: [true] }).fetch).sketch("p")).rejects.toThrow("safety");
    await expect(make(queue({}, ["FAILED"]).fetch).sketch("p")).rejects.toThrow("FAILED");
    await expect(make(queue({ images: [] }).fetch).sketch("p")).rejects.toThrow("no picture");
    const refused = (async () => new Response("nope", { status: 401 })) as unknown as typeof globalThis.fetch;
    await expect(make(refused).model("x")).rejects.toThrow("401");
  });
});
