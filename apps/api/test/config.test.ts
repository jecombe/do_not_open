import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("config", () => {
  it("takes `NAME=` with nothing after it as unset, as .env.example lists them", () => {
    const config = loadConfig({ ALLOW_LIST_PLACES: "", X_CLIENT_ID: "", X_CLIENT_SECRET: "", SITE_URL: "" });
    expect(config.ALLOW_LIST_PLACES).toBeUndefined();
    expect(config.X_CLIENT_ID).toBeUndefined();
    expect(config.SITE_URL).toBeUndefined();
  });

  it("puts no cap on the allow list unless one is set", () => {
    expect(loadConfig({}).ALLOW_LIST_PLACES).toBeUndefined();
    expect(loadConfig({ ALLOW_LIST_PLACES: "800" }).ALLOW_LIST_PLACES).toBe(800);
  });
});
