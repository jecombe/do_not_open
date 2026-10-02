/**
 * Values the connected account already decrypted, by handle. A handle names one ciphertext
 * forever: whatever it decrypted to once, it decrypts to again. Asking the relayer twice only
 * costs the collection a second decryption fee, and the wallet a second signature.
 */
export interface DecryptCache {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type Clear = bigint | boolean | string;

/** Kept in memory: the default, and what Node scripts use. */
export class MemoryDecryptCache implements DecryptCache {
  private readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/**
 * Kept in the browser across visits, so a returning player does not pay to decrypt their old
 * receipts again. Only this browser's storage holds it, as it already holds the shakes the
 * player saw. Past `max` entries, the oldest go first.
 */
export class LocalStorageDecryptCache implements DecryptCache {
  private readonly memory = new MemoryDecryptCache();

  constructor(
    private readonly prefix: string,
    private readonly max = 5000,
  ) {}

  get(key: string): string | null {
    const hit = this.memory.get(key);
    if (hit !== null) return hit;
    try {
      const stored = this.load()[key];
      return stored === undefined ? null : stored;
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    this.memory.set(key, value);
    try {
      const all = this.load();
      delete all[key];
      all[key] = value;
      const keys = Object.keys(all);
      for (const old of keys.slice(0, Math.max(0, keys.length - this.max))) delete all[old];
      localStorage.setItem(this.prefix, JSON.stringify(all));
    } catch {
      // Private mode or a full storage: the memory copy still serves this visit.
    }
  }

  private load(): Record<string, string> {
    return JSON.parse(localStorage.getItem(this.prefix) ?? "{}") as Record<string, string>;
  }
}

export function encodeClear(v: Clear): string {
  if (typeof v === "boolean") return v ? "b1" : "b0";
  if (typeof v === "bigint") return `n${v}`;
  return `s${v}`;
}

export function decodeClear(s: string): Clear {
  if (s === "b1") return true;
  if (s === "b0") return false;
  if (s.startsWith("n")) return BigInt(s.slice(1));
  return s.slice(1);
}
