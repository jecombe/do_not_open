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

  it("cuts the sketch out first, then asks Hunyuan3D for a textured mesh", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const results = [{ image: { url: "https://fal.media/cut.png" } }, { model_mesh: { url: "https://fal.media/rat.glb" } }];
    const fetch = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ request_id: "r", status_url: `https://q/${calls.length}/status`, response_url: `https://q/${calls.length}` });
      }
      if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
      return Response.json(results[Number(url.split("/").pop()) - 1]);
    }) as unknown as typeof globalThis.fetch;
    const fal = new FalStudio({ apiKey: "k", imageModel: "fal-ai/flux/schnell", modelModel: "fal-ai/hunyuan3d/v2", cutoutModel: "fal-ai/birefnet", timeoutMs: 5_000, pollMs: 1, queueUrl: "https://queue.test", fetch });
    expect(await fal.model("https://fal.media/sketch.jpg")).toEqual({ url: "https://fal.media/rat.glb" });
    expect(calls).toEqual([
      { url: "https://queue.test/fal-ai/birefnet", body: { image_url: "https://fal.media/sketch.jpg" } },
      { url: "https://queue.test/fal-ai/hunyuan3d/v2", body: { input_image_url: "https://fal.media/cut.png", textured_mesh: true } },
    ]);
  });

  it("asks Tripo for a GLB with plain textures", async () => {
    const { calls, fetch } = queue({ model_mesh: { url: "https://v3.fal.media/rat.glb" } });
    const fal = new FalStudio({ apiKey: "k", imageModel: "fal-ai/flux/schnell", modelModel: "tripo3d/h3.1/image-to-3d", timeoutMs: 5_000, pollMs: 1, queueUrl: "https://queue.test", fetch });
    expect(await fal.model("https://fal.media/sketch.jpg")).toEqual({ url: "https://v3.fal.media/rat.glb" });
    expect(calls[0]).toMatchObject({
      url: "https://queue.test/tripo3d/h3.1/image-to-3d",
      body: { image_url: "https://fal.media/sketch.jpg", texture: true, pbr: false, texture_quality: "standard", geometry_quality: "standard" },
    });
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
