import { describe, expect, it } from "vitest";
import { FREE_UNITS, loadConfig } from "../src/config";

describe("config", () => {
  it("takes `NAME=` with nothing after it as unset, as .env.example lists them", () => {
    const config = loadConfig({ ALLOW_LIST_PLACES: "", X_CLIENT_ID: "", X_CLIENT_SECRET: "", SITE_URL: "" });
    expect(config.ALLOW_LIST_PLACES).toBe(1500);
    expect(config.X_CLIENT_ID).toBeUndefined();
    expect(config.SITE_URL).toBeUndefined();
  });

  it("seats 1,500 (the spec's whitelist.places) on the mainnet list unless told otherwise", () => {
    expect(loadConfig({}).ALLOW_LIST_PLACES).toBe(1500);
    expect(loadConfig({ ALLOW_LIST_PLACES: "800" }).ALLOW_LIST_PLACES).toBe(800);
  });
  it("gives each network its own free decryptions a day, and lets the environment set them", () => {
    const sepolia = loadConfig({});
    expect(sepolia.RELAYER_FREE_PER_DAY).toBe(FREE_UNITS.sepolia.perDay);
    expect(sepolia.RELAYER_NEWCOMER_PER_DAY).toBe(FREE_UNITS.sepolia.newcomer);
    // Mainnet keeps the figures the credit price was worked out for.
    expect(FREE_UNITS.mainnet).toEqual({ perDay: 25, newcomer: 16 });
    const set = loadConfig({ RELAYER_FREE_PER_DAY: "40", RELAYER_NEWCOMER_PER_DAY: "0" });
    expect([set.RELAYER_FREE_PER_DAY, set.RELAYER_NEWCOMER_PER_DAY]).toEqual([40, 0]);
  });
});
