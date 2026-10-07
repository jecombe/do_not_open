import { z } from "zod";
import { allowanceOf, charge, dayOf, publicDecryptionKey, refund, type Allowance } from "../domain/relayer";
import { normalizeAddress, type Address } from "../domain/types";
import type { Clock } from "./auth";
import type { PermitVerifier, PublicationCheck, RelayerUpstream, UpstreamReply, UserDecryptPermit } from "./ports/relayer";
import type { Store } from "./ports/store";

export type RelayerOp = "input-proof" | "user-decrypt" | "public-decrypt";

export type RefusalCode = "no-credits" | "not-ours" | "bad-permit" | "bad-request";

/** A request the gate turned away before it reached Zama, so it cost nothing. */
export class RelayerRefused extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly allowance?: Allowance,
  ) {
    super(message);
  }
}

export interface GateConfig {
  /** The host chain: requests for another are refused. */
  chainId: number;
  /** Lowercase addresses of the contracts whose values may be decrypted, and inputs made for. */
  contracts: () => Promise<string[]>;
  /** Free units a wallet gets each UTC day, once it has acted on-chain or been sent a box. */
  freePerDay: number;
  /** Free units a day for a wallet the index has never seen: enough for a first mint, little
   *  for a farm of fresh wallets. */
  newcomerPerDay: number;
  /** Units one encrypted input costs: what Zama charges for one over what it charges for a decryption. */
  inputUnits: number;
  /** Units a value costs in a public decryption sent to Zama, charged to the wallet whose
   *  permit comes with it. 0 keeps public decryptions free and anonymous. */
  publicUnits: number;
  /** Most handles one decryption may ask for. */
  maxHandles: number;
  /** A permit signed more than this far in the future is refused. Seconds. */
  clockSkew: number;
  /** Requests sent to Zama that may name one handle: the same request is answered from the
   *  cache, and this bounds what reshuffling the handles of a request can cost. */
  publicPerHandle: number;
}

/** A public decryption still running after this long is taken as lost and sent again. Seconds. */
const PUBLIC_PENDING_TTL = 300;

const hex = z.string().regex(/^(0x)?[0-9a-fA-F]*$/, "not hex");
const handle = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "not a handle").transform((h) => h.toLowerCase());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not an address").transform(normalizeAddress);
const uint = z.string().regex(/^\d{1,20}$/, "not a number");

const userDecryptBody = z.object({
  handleContractPairs: z.array(z.object({ handle, contractAddress: address })).min(1),
  requestValidity: z.object({ startTimestamp: uint, durationDays: uint }),
  contractsChainId: uint,
  contractAddresses: z.array(address).min(1).max(10),
  userAddress: address,
  signature: hex,
  publicKey: hex,
  extraData: hex,
});
const publicDecryptBody = z.object({ ciphertextHandles: z.array(handle).min(1), extraData: hex });
const inputProofBody = z.object({
  contractAddress: address,
  userAddress: address,
  ciphertextWithInputVerification: hex,
  contractChainId: z.string().regex(/^0x[0-9a-fA-F]+$/),
  extraData: hex,
});

const permitToken = z.object({
  publicKey: hex,
  contractAddresses: z.array(address).min(1).max(10),
  startTimestamp: uint,
  durationDays: uint,
  extraData: hex,
  signature: hex,
});

const KEYURL_TTL_MS = 10 * 60_000;

/**
 * What the app sends as a bearer token with an encrypted input: the user-decryption permit it
 * already signed, so an input is charged to the wallet that made it without asking for
 * another signature. Base64url of its JSON.
 */
export function encodePermitToken(p: UserDecryptPermit): string {
  return Buffer.from(JSON.stringify(p)).toString("base64url");
}

/**
 * The only way the app reaches Zama's relayer on a network where the collection pays for it.
 * It holds the API key, and lets through only what the game needs:
 *
 * - a user decryption of the protocol's own contracts, signed by the wallet it is for, out of
 *   that wallet's free daily units, then its credits: one unit a value;
 * - an encrypted input for one of the protocol's contracts, sent with the permit of the wallet
 *   it is for, charged the same way: `inputUnits` an input, since Zama bills an input several
 *   times a decryption;
 * - a public decryption of handles the protocol's contracts made public (a request, a duel,
 *   a milestone, a weigh-in, an unwrap): `publicUnits` a value, charged to the wallet whose
 *   permit comes with it, so posting and taking up duels in a loop spends the griefer's units,
 *   not the collection's money. A handle's value never changes, so each request is sent to
 *   Zama once and answered from the cache after, free for whoever asks again, and a handle may
 *   only be named in `publicPerHandle` requests sent there.
 */
export class RelayerGate {
  private keyurl: { at: number; reply: UpstreamReply } | null = null;

  constructor(
    private readonly store: Store,
    private readonly upstream: RelayerUpstream,
    private readonly verifier: PermitVerifier,
    private readonly publications: PublicationCheck,
    private readonly clock: Clock,
    private readonly cfg: GateConfig,
  ) {}

  async allowance(account: Address): Promise<Allowance> {
    const now = this.clock.now();
    return allowanceOf(await this.store.meterOf(account, dayOf(now)), await this.freePerDay(account), now, this.cfg.inputUnits, this.cfg.publicUnits);
  }

  /** `authorization` is the request's Authorization header: an encrypted input needs it. */
  async submit(op: RelayerOp, body: unknown, authorization?: string): Promise<UpstreamReply> {
    switch (op) {
      case "user-decrypt":
        return this.userDecrypt(body);
      case "public-decrypt":
        return this.publicDecrypt(body, authorization);
      case "input-proof":
        return this.inputProof(body, authorization);
    }
  }

  /** Where a queued job stands. Free: the job was metered when it was submitted. */
  async poll(op: RelayerOp, jobId: string): Promise<UpstreamReply> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new RelayerRefused("bad-request", "not a job id");
    if (op !== "public-decrypt") return this.upstream.get(`${op}/${jobId}`);
    const known = await this.store.publicDecryptionOfJob(jobId);
    if (known?.result != null) return { status: 200, body: known.result, retryAfter: null };
    const reply = await this.upstream.get(`${op}/${jobId}`);
    if (known && reply.status === 200) await this.store.finishPublicDecryption(jobId, reply.body);
    else if (known && reply.status >= 400) await this.store.dropPublicDecryption(jobId);
    return reply;
  }

  /** Where the network's public key lives. The same for everyone: kept a few minutes. */
  async keyUrl(): Promise<UpstreamReply> {
    const now = Date.now();
    if (this.keyurl && now - this.keyurl.at < KEYURL_TTL_MS) return this.keyurl.reply;
    const reply = await this.upstream.get("keyurl");
    if (reply.status === 200) this.keyurl = { at: now, reply };
    return reply;
  }

  private async userDecrypt(raw: unknown): Promise<UpstreamReply> {
    const body = this.parse(userDecryptBody, raw);
    if (Number(body.contractsChainId) !== this.cfg.chainId) throw new RelayerRefused("bad-request", "wrong chain");
    if (body.handleContractPairs.length > this.cfg.maxHandles) throw new RelayerRefused("bad-request", `at most ${this.cfg.maxHandles} values at once`);
    const ours = new Set(await this.cfg.contracts());
    if (body.handleContractPairs.some((p) => !ours.has(p.contractAddress))) throw new RelayerRefused("not-ours", "only this game's contracts can be decrypted here");
    const signer = await this.permitSigner(
      { ...body.requestValidity, publicKey: body.publicKey, contractAddresses: body.contractAddresses, extraData: body.extraData, signature: body.signature },
      ours,
    );
    // Only the wallet itself spends its allowance and its credits.
    if (signer !== body.userAddress) throw new RelayerRefused("bad-permit", "the permit was signed by another account");
    const units = body.handleContractPairs.length;
    return this.metered(body.userAddress, units, `${units} decryption${units === 1 ? "" : "s"}`, () => this.upstream.post("user-decrypt", raw));
  }

  /**
   * Who signed a permit for the protocol's contracts that is valid now. Refuses one naming
   * another app's contract, one out of its validity, and one that does not recover.
   */
  private async permitSigner(p: UserDecryptPermit, ours: Set<string>): Promise<Address> {
    if (p.contractAddresses.some((a) => !ours.has(normalizeAddress(a)))) throw new RelayerRefused("not-ours", "only this game's contracts can be decrypted here");
    const now = this.clock.now();
    const start = Number(p.startTimestamp);
    const days = Number(p.durationDays);
    if (start > now + this.cfg.clockSkew || start + days * 86_400 <= now) throw new RelayerRefused("bad-permit", "the decryption permit has expired");
    try {
      return this.verifier.signer(p);
    } catch {
      throw new RelayerRefused("bad-permit", "unreadable permit signature");
    }
  }

  /**
   * Takes `units` from the account's day (free units first, then credits), forwards, and gives
   * them back when Zama turns the request away or cannot be reached: it is only billed for
   * what it takes.
   */
  private async metered(account: Address, units: number, what: string, forward: () => Promise<UpstreamReply>): Promise<UpstreamReply> {
    const day = dayOf(this.clock.now());
    const freePerDay = await this.freePerDay(account);
    const taken = await this.store.meter(account, day, (m) => charge(units, m, freePerDay));
    if (!taken) throw new RelayerRefused("no-credits", `${what} needed: ${units} unit${units === 1 ? "" : "s"}, and no free one left today nor enough credits`, await this.allowance(account));
    let reply: UpstreamReply;
    try {
      reply = await forward();
    } catch (error) {
      await this.store.meter(account, day, () => refund(taken));
      throw error;
    }
    if (reply.status >= 400) await this.store.meter(account, day, () => refund(taken));
    return reply;
  }

  /** A wallet that has acted on-chain, or was sent a box, is a player; any other is a newcomer. */
  private async freePerDay(account: Address): Promise<number> {
    if (this.cfg.newcomerPerDay >= this.cfg.freePerDay) return this.cfg.freePerDay;
    const user = await this.store.user(account);
    if ((user?.actions ?? 0) > 0) return this.cfg.freePerDay;
    return (await this.store.transfers(account, 0, 1)).length ? this.cfg.freePerDay : this.cfg.newcomerPerDay;
  }

  private async publicDecrypt(raw: unknown, authorization?: string): Promise<UpstreamReply> {
    const body = this.parse(publicDecryptBody, raw);
    if (body.ciphertextHandles.length > this.cfg.maxHandles) throw new RelayerRefused("bad-request", `at most ${this.cfg.maxHandles} values at once`);
    const known = new Set(await this.store.publishedAmong(body.ciphertextHandles));
    let missing = body.ciphertextHandles.filter((h) => !known.has(h));
    if (missing.length) {
      const recent = new Set(await this.publications.recentlyPublished(missing));
      missing = missing.filter((h) => !recent.has(h));
    }
    if (missing.length) throw new RelayerRefused("not-ours", "only values this game made public can be decrypted here");

    // Asked before: the same job, answered from the cache once it is done.
    const key = publicDecryptionKey(body.ciphertextHandles, body.extraData);
    const now = this.clock.now();
    const asked = await this.store.publicDecryption(key);
    if (asked && (asked.result !== null || now - asked.at < PUBLIC_PENDING_TTL)) return { status: 202, body: asked.queued, retryAfter: "1" };

    const uses = await this.store.publicDecryptionsOf(body.ciphertextHandles);
    if (body.ciphertextHandles.some((h) => (uses.get(h) ?? 0) >= this.cfg.publicPerHandle)) {
      throw new RelayerRefused("bad-request", "this value was already decrypted publicly; ask with the same handles as before");
    }
    // Only a request sent to Zama is charged: the one who asks first pays, the cache is free.
    const units = body.ciphertextHandles.length * this.cfg.publicUnits;
    const send = () => this.upstream.post("public-decrypt", raw);
    const reply = units > 0 ? await this.metered(await this.bearerAccount(authorization, "A public decryption"), units, `A public decryption of ${body.ciphertextHandles.length} value${body.ciphertextHandles.length === 1 ? "" : "s"}`, send) : await send();
    const jobId = (reply.body as { result?: { jobId?: unknown } } | null)?.result?.jobId;
    if (reply.status === 202 && typeof jobId === "string") {
      await this.store.savePublicDecryption({ key, jobId, queued: reply.body, at: now }, [...new Set(body.ciphertextHandles)]);
    }
    return reply;
  }

  private async inputProof(raw: unknown, authorization?: string): Promise<UpstreamReply> {
    const body = this.parse(inputProofBody, raw);
    if (BigInt(body.contractChainId) !== BigInt(this.cfg.chainId)) throw new RelayerRefused("bad-request", "wrong chain");
    const ours = new Set(await this.cfg.contracts());
    if (!ours.has(body.contractAddress)) throw new RelayerRefused("not-ours", "inputs can only be made for this game's contracts");
    // The input names the wallet it is for, but nothing in it proves who sent it: the permit
    // does, or anyone could spend someone else's allowance and credits.
    if ((await this.bearerAccount(authorization, "An encrypted input")) !== body.userAddress) throw new RelayerRefused("bad-permit", "the permit was signed by another account");
    return this.metered(body.userAddress, this.cfg.inputUnits, "An encrypted input", () => this.upstream.post("input-proof", raw));
  }

  /** The wallet whose decryption permit comes as the bearer token: the one a request is charged to. */
  private async bearerAccount(authorization: string | undefined, what: string): Promise<Address> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    if (!token) throw new RelayerRefused("bad-permit", `${what} needs the wallet's decryption permit`);
    let permit: UserDecryptPermit;
    try {
      permit = permitToken.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    } catch {
      throw new RelayerRefused("bad-permit", "unreadable permit");
    }
    return this.permitSigner(permit, new Set(await this.cfg.contracts()));
  }

  private parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new RelayerRefused("bad-request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    return parsed.data;
  }
}
