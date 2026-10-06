import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "ethers";
import type { SessionSigner, SignatureVerifier } from "../../application/auth";
import { normalizeAddress, type Address } from "../../domain/types";

export const ethersVerifier: SignatureVerifier = {
  recover: (message, signature) => verifyMessage(message, signature),
};

export const randomNonce = () => randomBytes(16).toString("hex");

/** `address.expiresAt.mac`: signed with a server secret, checked without a database. */
export class HmacSessions implements SessionSigner {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  issue(address: Address, expiresAt: number): string {
    const payload = `${normalizeAddress(address)}.${expiresAt}`;
    return `${payload}.${this.mac(payload)}`;
  }

  verify(token: string, now: number): Address | null {
    const [address, exp, mac] = token.split(".");
    if (!address || !exp || !mac || !/^0x[0-9a-f]{40}$/.test(address)) return null;
    const expected = Buffer.from(this.mac(`${address}.${exp}`));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return Number(exp) > now ? address : null;
  }
}

// No 0/O or 1/I: a code is read off a screen and typed into a post.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Boarding pass secrets: a 32-byte token for the browser, its sha256 for the store, a short public code. */
export const passSecrets = {
  token() {
    const token = randomBytes(32).toString("base64url");
    return { token, id: createHash("sha256").update(token).digest("hex") };
  },
  hash: (token: string) => createHash("sha256").update(token).digest("hex"),
  code() {
    const bytes = randomBytes(6);
    return `DNO-${[...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
  },
};
