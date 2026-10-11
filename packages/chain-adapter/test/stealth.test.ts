import { computeAddress, SigningKey, Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { isStealthMeta } from "../src/stealthMeta";
import { formatStealthMeta, parseStealthMeta, parseStealthMetadata, stealthAddressFor, stealthKeyFor, stealthKeysFrom, stealthMetaOf, stealthMetadata } from "../src/evm/stealth";

describe("stealth addresses (ERC-5564, scheme 1)", () => {
  const signature = "0x" + "5a".repeat(65);
  const keys = stealthKeysFrom(signature);
  const meta = stealthMetaOf(keys);

  it("derives two keys from the signature, and the same ones every time", () => {
    expect(stealthKeysFrom(signature)).toEqual(keys);
    expect(keys.spendingKey).not.toEqual(keys.viewingKey);
    expect(stealthKeysFrom("0x" + "5b".repeat(65)).spendingKey).not.toEqual(keys.spendingKey);
  });

  it("writes and reads a meta-address", () => {
    const text = formatStealthMeta(meta);
    expect(text).toMatch(/^st:eth:0x[0-9a-f]{132}$/);
    expect(isStealthMeta(text)).toBe(true);
    expect(isStealthMeta(text.replace("st:eth:", ""))).toBe(true);
    expect(parseStealthMeta(text)).toEqual(meta);
    expect(parseStealthMeta(text.toUpperCase().replace("ST:ETH:", "st:eth:"))).toEqual(meta);
    expect(parseStealthMeta("0x1234")).toBe(null);
    // 66 bytes that are not points on the curve.
    expect(parseStealthMeta("st:eth:0x" + "00".repeat(66))).toBe(null);
  });

  it("pays an address only the recipient can spend, found by the view tag and the ephemeral key", () => {
    const payment = stealthAddressFor(meta);
    const key = stealthKeyFor(keys, payment);
    expect(key).not.toBe(null);
    expect(computeAddress(new SigningKey(key!).publicKey)).toEqual(payment.address);
    expect(new Wallet(key!).address).toEqual(payment.address);
    // Another payment to the same meta-address lands elsewhere.
    expect(stealthAddressFor(meta).address).not.toEqual(payment.address);
    // Someone else's keys open nothing, nor does a wrong view tag.
    expect(stealthKeyFor(stealthKeysFrom("0x" + "5b".repeat(65)), payment)).toBe(null);
    expect(stealthKeyFor(keys, { ...payment, viewTag: (payment.viewTag + 1) % 256 })).toBe(null);
    // Without the tag the full check still decides.
    expect(stealthKeyFor(keys, { address: payment.address, ephemeralPub: payment.ephemeralPub })).toEqual(key);
    expect(stealthKeyFor(keys, { address: Wallet.createRandom().address, ephemeralPub: payment.ephemeralPub })).toBe(null);
  });

  it("announces the token and no amount", () => {
    const token = "0x3c925f9ab849abbcb47ec12be0d9bdb4d9ea4395";
    const metadata = stealthMetadata(0xab, token);
    expect(metadata).toHaveLength(2 + 2 * (1 + 4 + 20 + 32));
    expect(parseStealthMetadata(metadata)).toEqual({ viewTag: 0xab, token });
    expect(parseStealthMetadata("0x07")).toEqual({ viewTag: 7, token: null });
  });
});
