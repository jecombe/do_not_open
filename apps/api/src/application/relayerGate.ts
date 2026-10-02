import { z } from "zod";
import { allowanceOf, charge, dayOf, refund, type Allowance } from "../domain/relayer";
import { normalizeAddress, type Address } from "../domain/types";
import type { Clock } from "./auth";
import type { PermitVerifier, PublicationCheck, RelayerUpstream, UpstreamReply } from "./ports/relayer";
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
  /** Free units a wallet gets each UTC day. */
  freePerDay: number;
  /** Most handles one decryption may ask for. */
  maxHandles: number;
  /** A permit signed more than this far in the future is refused. Seconds. */
  clockSkew: number;
}

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

const KEYURL_TTL_MS = 10 * 60_000;

/**
 * The only way the app reaches Zama's relayer on a network where the collection pays for it.
 * It holds the API key, and lets through only what the game needs:
 *
 * - a user decryption of the protocol's own contracts, signed by the wallet it is for, out of
 *   that wallet's free daily units, then its credits;
 * - a public decryption of handles the protocol's contracts made public (a request, a duel,
 *   a milestone, a weigh-in, an unwrap): free, it settles something already on-chain;
 * - an encrypted input for one of the protocol's contracts: free, the action it goes with is
 *   paid or costs gas.
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
    return allowanceOf(await this.store.meterOf(account, dayOf(now)), this.cfg.freePerDay, now);
  }

  async submit(op: RelayerOp, body: unknown): Promise<UpstreamReply> {
    switch (op) {
      case "user-decrypt":
        return this.userDecrypt(body);
      case "public-decrypt":
        return this.publicDecrypt(body);
      case "input-proof":
        return this.inputProof(body);
    }
  }

  /** Where a queued job stands. Free: the job was metered when it was submitted. */
  async poll(op: RelayerOp, jobId: string): Promise<UpstreamReply> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new RelayerRefused("bad-request", "not a job id");
    return this.upstream.get(`${op}/${jobId}`);
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
    const named = [...body.contractAddresses, ...body.handleContractPairs.map((p) => p.contractAddress)];
    if (named.some((a) => !ours.has(a))) throw new RelayerRefused("not-ours", "only this game's contracts can be decrypted here");

    const now = this.clock.now();
    const start = Number(body.requestValidity.startTimestamp);
    const days = Number(body.requestValidity.durationDays);
    if (start > now + this.cfg.clockSkew || start + days * 86_400 <= now) throw new RelayerRefused("bad-permit", "the decryption permit has expired");
    let signer: Address;
    try {
      signer = this.verifier.signer({
        publicKey: body.publicKey,
        contractAddresses: body.contractAddresses,
        startTimestamp: body.requestValidity.startTimestamp,
        durationDays: body.requestValidity.durationDays,
        extraData: body.extraData,
        signature: body.signature,
      });
    } catch {
      throw new RelayerRefused("bad-permit", "unreadable permit signature");
    }
    // Only the wallet itself spends its allowance and its credits.
    if (signer !== body.userAddress) throw new RelayerRefused("bad-permit", "the permit was signed by another account");

    const account = body.userAddress;
    const day = dayOf(now);
    const units = body.handleContractPairs.length;
    const taken = await this.store.meter(account, day, (m) => charge(units, m, this.cfg.freePerDay));
    if (!taken) {
      throw new RelayerRefused("no-credits", `${units} decryption${units === 1 ? "" : "s"} needed: no free one left today, and not enough credits`, await this.allowance(account));
    }
    let reply: UpstreamReply;
    try {
      reply = await this.upstream.post("user-decrypt", raw);
    } catch (error) {
      await this.store.meter(account, day, () => refund(taken));
      throw error;
    }
    // Turned away by Zama: not billed, so not counted.
    if (reply.status >= 400) await this.store.meter(account, day, () => refund(taken));
    return reply;
  }

  private async publicDecrypt(raw: unknown): Promise<UpstreamReply> {
    const body = this.parse(publicDecryptBody, raw);
    if (body.ciphertextHandles.length > this.cfg.maxHandles) throw new RelayerRefused("bad-request", `at most ${this.cfg.maxHandles} values at once`);
    const known = new Set(await this.store.publishedAmong(body.ciphertextHandles));
    let missing = body.ciphertextHandles.filter((h) => !known.has(h));
    if (missing.length) {
      const recent = new Set(await this.publications.recentlyPublished(missing));
      missing = missing.filter((h) => !recent.has(h));
    }
    if (missing.length) throw new RelayerRefused("not-ours", "only values this game made public can be decrypted here");
    return this.upstream.post("public-decrypt", raw);
  }

  private async inputProof(raw: unknown): Promise<UpstreamReply> {
    const body = this.parse(inputProofBody, raw);
    if (BigInt(body.contractChainId) !== BigInt(this.cfg.chainId)) throw new RelayerRefused("bad-request", "wrong chain");
    if (!(await this.cfg.contracts()).includes(body.contractAddress)) throw new RelayerRefused("not-ours", "inputs can only be made for this game's contracts");
    return this.upstream.post("input-proof", raw);
  }

  private parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new RelayerRefused("bad-request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    return parsed.data;
  }
}
