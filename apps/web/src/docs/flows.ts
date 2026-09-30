export type StationId = "you" | "other" | "contract" | "copro" | "kms";

/** What travels: a transaction, a ciphertext, a clear value, a signed proof, a signature. */
export type PacketKind = "tx" | "cipher" | "plain" | "proof" | "sign";

export interface FlowStep {
  from: StationId;
  /** Same as `from` for something a party does on its own. */
  to: StationId;
  kind: PacketKind;
  title: string;
  text: string;
}

export interface Flow {
  key: string;
  name: string;
  summary: string;
  steps: FlowStep[];
}

export const STATION_NAMES: Record<StationId, string> = {
  you: "You",
  other: "Other holder",
  contract: "DoNotOpen contract",
  copro: "Coprocessor",
  kms: "Relayer and KMS",
};

export const PACKET_NAMES: Record<PacketKind, string> = {
  tx: "Transaction",
  cipher: "Ciphertext",
  plain: "Clear value",
  proof: "Value with proof",
  sign: "Signature",
};

export const FLOWS: Flow[] = [
  {
    key: "mint",
    name: "Mint",
    summary: "A box is born sealed. Its contents are drawn where nobody can see them.",
    steps: [
      { from: "you", to: "contract", kind: "tx", title: "You order a box", text: "mint(1), with the price. The transaction says how many boxes, nothing else." },
      { from: "contract", to: "copro", kind: "cipher", title: "The seed is drawn encrypted", text: "The contract asks for a random 64-bit number and gets back a handle: the name of a ciphertext, not its value." },
      { from: "contract", to: "contract", kind: "cipher", title: "Only the contract may touch it", text: "The access list of that seed gets one entry, the contract itself. Not you, not the deployer." },
      { from: "contract", to: "you", kind: "plain", title: "A sealed box arrives", text: "You hold token DNO-0042. Its serial number is the only thing about it that exists in the clear." },
    ],
  },
  {
    key: "shake",
    name: "Shake",
    summary: "The holder learns one trait. Nobody else learns anything, not even which trait it was.",
    steps: [
      { from: "you", to: "contract", kind: "tx", title: "You shake the box", text: "shake(tokenId). Free, as often as you like, holders only." },
      { from: "contract", to: "copro", kind: "cipher", title: "One byte is cut out, blind", text: "Under encryption: pick one of the five traits at random, shift the seed, keep that byte. The pick is encrypted too." },
      { from: "contract", to: "contract", kind: "cipher", title: "Two new ciphertexts, for you alone", text: "Which trait, and its value. The contract adds you to their access list. The seed's list does not change." },
      { from: "you", to: "kms", kind: "sign", title: "You sign a permit", text: "Once per session: re-encrypt, for a key that lives in this page, what my account is allowed to read on this contract." },
      { from: "kms", to: "contract", kind: "plain", title: "The key service checks the list", text: "It reads the access list on-chain. You are on it for these two values, so it goes ahead." },
      { from: "kms", to: "you", kind: "cipher", title: "The answer comes back wrapped", text: "Re-encrypted for your session key. The relayer that carried it cannot read it." },
      { from: "you", to: "you", kind: "plain", title: "Your browser unwraps it", text: "Mood: Judging. The event on-chain only says that a shake happened." },
    ],
  },
  {
    key: "open",
    name: "Open",
    summary: "Two transactions with a decryption in between. There is no callback on this protocol.",
    steps: [
      { from: "you", to: "contract", kind: "tx", title: "You open the box", text: "observe(tokenId), with the fee. From here there is no way back." },
      { from: "contract", to: "contract", kind: "cipher", title: "The seed is marked public", text: "The box goes to Observing. Its seed, and its affection if it was ever fed, become publicly decryptable." },
      { from: "you", to: "kms", kind: "cipher", title: "Anyone may now ask for it", text: "The app asks the relayer to decrypt the handles the contract lists for this box." },
      { from: "kms", to: "you", kind: "proof", title: "The seed, signed", text: "The clear values come back with signatures from the parties that hold the key shares." },
      { from: "you", to: "contract", kind: "proof", title: "The proof goes on-chain", text: "finalizeObserve(values, proof). Anyone may send it. If you close the tab, someone else can finish." },
      { from: "contract", to: "contract", kind: "plain", title: "Checked against its own records", text: "The contract rebuilds the handle list from storage, verifies the signatures, decodes the seed and writes the cat down." },
      { from: "contract", to: "you", kind: "plain", title: "The box opens", text: "State, five traits, rarity score. The app rebuilds the cat from the seed and checks the two agree." },
    ],
  },
  {
    key: "duel",
    name: "Duel",
    summary: "Two hidden scores are compared. Three values become public, and the winner shows nothing.",
    steps: [
      { from: "you", to: "contract", kind: "tx", title: "You challenge a box", text: "challengeDuel(yours, theirs). Your box's rarity score is computed, encrypted, and kept for next time." },
      { from: "other", to: "contract", kind: "tx", title: "Its holder accepts", text: "acceptDuel(duelId). Both holders have to agree. Their box's score is computed the same way." },
      { from: "contract", to: "copro", kind: "cipher", title: "The comparison, blind", text: "Is your score higher? Pick a trait at random. Select the loser's value for that trait. All three stay encrypted." },
      { from: "contract", to: "contract", kind: "cipher", title: "Exactly three values go public", text: "Who won, which trait, the loser's value. The winner's value for that trait was never selected, so it is never decryptable." },
      { from: "you", to: "kms", kind: "cipher", title: "Anyone asks for the outcome", text: "Same road as opening a box: a public decryption of the three handles." },
      { from: "kms", to: "you", kind: "proof", title: "The outcome, signed", text: "Three clear values and the signatures that vouch for them." },
      { from: "you", to: "contract", kind: "proof", title: "The proof goes on-chain", text: "finalizeDuel(values, proof). The contract verifies it and records the win." },
      { from: "contract", to: "other", kind: "plain", title: "Everyone learns the result", text: "The winner's count goes up. The loser's revealed trait is now public, while the box stays sealed." },
    ],
  },
];
