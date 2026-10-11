import { computeAddress, concat, dataSlice, getBytes, hexlify, keccak256, randomBytes, SigningKey, solidityPackedKeccak256, toBeHex } from "ethers";

/**
 * ERC-5564 stealth addresses, scheme 1 (secp256k1 with view tags), as the pockets' exits use
 * them. A recipient has two keys, spending and viewing, published together as a meta-address.
 * A payer draws an ephemeral key, shares a secret with the viewing key (ECDH), and pays the
 * address of `spendingPub + hash(secret) * G`: one the recipient alone can spend (with
 * `spendingKey + hash(secret)`) and alone can recognise (with the viewing key), and that nothing
 * ties to them. The ephemeral public key goes on the announcer with a one-byte view tag, so a
 * recipient's page scans announcements cheaply. Everything here is plain secp256k1 arithmetic
 * from ethers; nothing is stored.
 */

/** secp256k1's order: private keys are taken modulo it. */
const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
export const STEALTH_SCHEME = 1;
/** ERC-5564's two contracts, deployed once for everyone on Ethereum, Sepolia and most other chains. */
export const STEALTH_ANNOUNCER = "0x55649E01B5Df198D18D95b5cc5051630cfD45564";
export const STEALTH_REGISTRY = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";
/** The ERC-20 `transfer` selector: what the metadata convention announces a token payment with. */
const TRANSFER_SELECTOR = "0xa9059cbb";

/** A stealth meta-address: the compressed spending and viewing public keys, 33 bytes each, as `st:eth:0x…`. */
export interface StealthMeta {
  spendingPub: string;
  viewingPub: string;
}

/** The two private keys a recipient holds. */
export interface StealthKeys {
  spendingKey: string;
  viewingKey: string;
}

/** The two keys, derived from a signature the wallet gives once a session (the pocket signature): nothing is stored. */
export function stealthKeysFrom(signature: string): StealthKeys {
  return {
    spendingKey: solidityPackedKeccak256(["bytes", "string"], [signature, "stealth-spend"]),
    viewingKey: solidityPackedKeccak256(["bytes", "string"], [signature, "stealth-view"]),
  };
}

export function stealthMetaOf(keys: StealthKeys): StealthMeta {
  return { spendingPub: new SigningKey(keys.spendingKey).compressedPublicKey, viewingPub: new SigningKey(keys.viewingKey).compressedPublicKey };
}

/** `st:eth:0x` + 66 bytes, the form ERC-5564 writes a meta-address in and the registry stores. */
export function formatStealthMeta(meta: StealthMeta): string {
  return `st:eth:${concat([meta.spendingPub, meta.viewingPub])}`;
}

/** Parses `st:eth:0x…` or bare `0x…` (66 bytes); null when it is neither. */
export function parseStealthMeta(text: string): StealthMeta | null {
  const hex = text.trim().replace(/^st:eth:/i, "").toLowerCase();
  if (!/^0x[0-9a-f]{132}$/.test(hex)) return null;
  try {
    const spendingPub = dataSlice(hex, 0, 33);
    const viewingPub = dataSlice(hex, 33, 66);
    // Both must be points on the curve.
    SigningKey.computePublicKey(spendingPub, true);
    SigningKey.computePublicKey(viewingPub, true);
    return { spendingPub, viewingPub };
  } catch {
    return null;
  }
}

/** What a payer sends: the stealth address, the ephemeral public key and the view tag to announce. */
export interface StealthPayment {
  address: string;
  ephemeralPub: string;
  viewTag: number;
}

/** The shared secret's hash, from one side's private key and the other's public key. */
function sharedHash(privateKey: string, publicKey: string): string {
  return keccak256(new SigningKey(privateKey).computeSharedSecret(publicKey));
}

/** Draws a stealth address for `meta`, with a fresh ephemeral key. */
export function stealthAddressFor(meta: StealthMeta): StealthPayment {
  const ephemeral = new SigningKey(hexlify(randomBytes(32)));
  const h = sharedHash(ephemeral.privateKey, meta.viewingPub);
  const stealthPub = SigningKey.addPoints(meta.spendingPub, SigningKey.computePublicKey(h, true), true);
  return { address: computeAddress(stealthPub), ephemeralPub: ephemeral.compressedPublicKey, viewTag: getBytes(h)[0]! };
}

/**
 * Whether an announcement is for `keys`, and the stealth address's private key when it is. The
 * view tag turns most strangers' announcements away with one hash; a match is then checked in full.
 */
export function stealthKeyFor(keys: StealthKeys, announced: { address: string; ephemeralPub: string; viewTag?: number }): string | null {
  let h: string;
  try {
    h = sharedHash(keys.viewingKey, announced.ephemeralPub);
  } catch {
    return null;
  }
  if (announced.viewTag !== undefined && getBytes(h)[0] !== announced.viewTag) return null;
  const spendingPub = SigningKey.computePublicKey(keys.spendingKey, true);
  const stealthPub = SigningKey.addPoints(spendingPub, SigningKey.computePublicKey(h, true), true);
  if (computeAddress(stealthPub).toLowerCase() !== announced.address.toLowerCase()) return null;
  return toBeHex((BigInt(keys.spendingKey) + BigInt(h)) % N, 32);
}

/**
 * The announcement's metadata, as ERC-5564's convention writes a token payment: the view tag, the
 * `transfer` selector, the token and the amount. A pocket's amount is encrypted, so it announces
 * zero: the recipient's page reads the balance itself.
 */
export function stealthMetadata(viewTag: number, token: string): string {
  return concat([toBeHex(viewTag, 1), TRANSFER_SELECTOR, token, toBeHex(0, 32)]);
}

/** The view tag and the token of an announcement's metadata; the token null when it says none. */
export function parseStealthMetadata(metadata: string): { viewTag: number; token: string | null } {
  const bytes = getBytes(metadata);
  const viewTag = bytes[0] ?? 0;
  const token = bytes.length >= 25 && hexlify(bytes.slice(1, 5)) === TRANSFER_SELECTOR ? hexlify(bytes.slice(5, 25)) : null;
  return { viewTag, token };
}
