import { createHash } from "node:crypto";
import { getBytes, SigningKey, Wallet } from "ethers";

/**
 * ANS-104 data items signed with an Ethereum key: the envelope Arweave bundlers (Turbo) accept.
 * Written against `@dha-team/arbundles` (what the Turbo SDK uses) to avoid its Solana and native
 * dependencies; a test checks the bytes match for the same key, data and tags.
 */

export interface Tag {
  name: string;
  value: string;
}

/** Signature type 3: Ethereum (EIP-191 `personal_sign` of the deep hash). */
const ETHEREUM = 3;
const SIGNATURE_LENGTH = 65;
const OWNER_LENGTH = 65;

export interface DataItem {
  /** The Arweave id: base64url of the SHA-256 of the signature. */
  id: string;
  bytes: Uint8Array;
}

export async function signDataItem(privateKey: string, data: Uint8Array, tags: Tag[]): Promise<DataItem> {
  const wallet = new Wallet(privateKey);
  const owner = getBytes(new SigningKey(wallet.privateKey).publicKey); // 65 bytes, uncompressed
  const rawTags = serializeTags(tags);
  const message = deepHash([
    utf8("dataitem"),
    utf8("1"),
    utf8(String(ETHEREUM)),
    owner,
    new Uint8Array(0), // target
    new Uint8Array(0), // anchor
    rawTags,
    data,
  ]);
  const signature = getBytes(await wallet.signMessage(message));
  if (signature.length !== SIGNATURE_LENGTH || owner.length !== OWNER_LENGTH) throw new Error("unexpected key or signature length");

  const header = new Uint8Array(2 + SIGNATURE_LENGTH + OWNER_LENGTH + 1 + 1 + 8 + 8);
  const view = new DataView(header.buffer);
  let at = 0;
  view.setUint16(at, ETHEREUM, true);
  at += 2;
  header.set(signature, at);
  at += SIGNATURE_LENGTH;
  header.set(owner, at);
  at += OWNER_LENGTH;
  header[at++] = 0; // no target
  header[at++] = 0; // no anchor
  view.setBigUint64(at, BigInt(tags.length), true);
  at += 8;
  view.setBigUint64(at, BigInt(rawTags.length), true);

  return { id: base64url(sha256(signature)), bytes: concat([header, rawTags, data]) };
}

/** Arweave's deep hash (SHA-384) over nested byte arrays. */
export function deepHash(chunk: Uint8Array | Uint8Array[]): Uint8Array {
  if (chunk instanceof Uint8Array) {
    const tag = concat([utf8("blob"), utf8(String(chunk.length))]);
    return sha384(concat([sha384(tag), sha384(chunk)]));
  }
  let acc = sha384(concat([utf8("list"), utf8(String(chunk.length))]));
  for (const c of chunk) acc = sha384(concat([acc, deepHash(c)]));
  return acc;
}

/** Tags in Avro: one block of `{ name: bytes, value: bytes }` records, then an empty block. */
export function serializeTags(tags: Tag[]): Uint8Array {
  if (tags.length === 0) return new Uint8Array(0);
  const parts: Uint8Array[] = [avroLong(tags.length)];
  for (const t of tags) {
    for (const field of [utf8(t.name), utf8(t.value)]) parts.push(avroLong(field.length), field);
  }
  parts.push(avroLong(0));
  return concat(parts);
}

/** Zig-zag, then base-128 varint. */
function avroLong(n: number): Uint8Array {
  let z = BigInt(n) >= 0n ? BigInt(n) << 1n : (-BigInt(n) << 1n) - 1n;
  const out: number[] = [];
  do {
    let byte = Number(z & 0x7fn);
    z >>= 7n;
    if (z > 0n) byte |= 0x80;
    out.push(byte);
  } while (z > 0n);
  return Uint8Array.from(out);
}

function sha384(b: Uint8Array): Uint8Array {
  return createHash("sha384").update(b).digest();
}

function sha256(b: Uint8Array): Uint8Array {
  return createHash("sha256").update(b).digest();
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function base64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
