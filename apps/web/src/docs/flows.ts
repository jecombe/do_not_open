import { lookup, t } from "./i18n";

/** For keys assembled at runtime; the dictionaries are typed against the English one anyway. */
const tx = (key: string): string => lookup(key) ?? key;

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
  /** Whose parties these are, when not the collection's: names the stations differently. */
  cast?: string;
  steps: FlowStep[];
}

/** A station's name; a `cast` (the market's flows) may rename it, `station.contract.market`. */
export const stationName = (id: StationId, cast?: string): string => (cast && lookup(`station.${id}.${cast}`)) || t(`station.${id}`);
export const packetName = (kind: PacketKind): string => t(`packet.${kind}`);

type FlowKey = "mint" | "shake" | "open" | "duel" | "transfer" | "buy" | "offer";
type Route = [from: StationId, to: StationId, kind: PacketKind];

/** Who talks to whom, per step. The words for each step live in the dictionaries. */
const ROUTES: Record<FlowKey, Route[]> = {
  mint: [
    ["you", "contract", "tx"],
    ["contract", "copro", "cipher"],
    ["contract", "copro", "cipher"],
    ["contract", "contract", "cipher"],
    ["contract", "you", "cipher"],
    ["you", "kms", "sign"],
    ["kms", "you", "cipher"],
    ["you", "you", "plain"],
  ],
  shake: [
    ["you", "contract", "tx"],
    ["contract", "copro", "cipher"],
    ["contract", "contract", "cipher"],
    ["you", "kms", "sign"],
    ["kms", "contract", "plain"],
    ["kms", "you", "cipher"],
    ["you", "you", "plain"],
  ],
  open: [
    ["you", "contract", "tx"],
    ["contract", "copro", "cipher"],
    ["you", "kms", "cipher"],
    ["kms", "you", "proof"],
    ["you", "contract", "proof"],
    ["contract", "contract", "plain"],
    ["contract", "you", "plain"],
  ],
  duel: [
    ["you", "contract", "tx"],
    ["you", "kms", "cipher"],
    ["you", "contract", "proof"],
    ["other", "contract", "tx"],
    ["contract", "copro", "cipher"],
    ["contract", "contract", "cipher"],
    ["you", "kms", "cipher"],
    ["kms", "you", "proof"],
    ["you", "contract", "proof"],
    ["contract", "other", "plain"],
  ],
  transfer: [
    ["you", "contract", "tx"],
    ["contract", "copro", "cipher"],
    ["contract", "other", "cipher"],
    ["other", "kms", "sign"],
    ["kms", "other", "cipher"],
    ["other", "other", "plain"],
  ],
  buy: [
    ["you", "contract", "tx"],
    ["contract", "copro", "cipher"],
    ["you", "kms", "cipher"],
    ["kms", "you", "proof"],
    ["you", "contract", "proof"],
    ["contract", "contract", "plain"],
    ["contract", "other", "cipher"],
    ["contract", "you", "plain"],
  ],
  offer: [
    ["you", "contract", "tx"],
    ["contract", "copro", "cipher"],
    ["contract", "other", "cipher"],
    ["other", "kms", "sign"],
    ["kms", "other", "cipher"],
    ["other", "contract", "tx"],
    ["contract", "you", "plain"],
  ],
};

/** The flows that happen at the flea market: its contract and a seller stand on the dock. */
const CAST: Partial<Record<FlowKey, string>> = { buy: "market", offer: "market" };

/** The flows in the current language. Call it again after a language change. */
export function flows(): Flow[] {
  return (Object.keys(ROUTES) as FlowKey[]).map((key) => ({
    key,
    name: t(`flow.${key}.name`),
    summary: t(`flow.${key}.summary`),
    cast: CAST[key],
    steps: ROUTES[key].map(([from, to, kind], i) => ({ from, to, kind, title: tx(`flow.${key}.s${i + 1}`), text: tx(`flow.${key}.s${i + 1}.v`) })),
  }));
}
