/** Permanent public storage for the token images: Arweave, through a bundler that takes small files for free. */
export interface PermanentStorage {
  /** Largest upload the bundler takes for free; bigger images stay served by the API. */
  readonly maxBytes: number;
  /** Stores the bytes for good and returns their id. */
  put(data: Uint8Array, contentType: string): Promise<string>;
}

/**
 * Which images are already stored for good, by SHA-256 of their bytes. Not a read model: a replay
 * of the chain keeps it, and the same image is never uploaded twice.
 */
export interface ArchiveStore {
  /** The permanent id of each of these hashes that was stored; absent ones never were. */
  archivedImages(hashes: string[]): Promise<Map<string, string>>;
  saveArchivedImage(hash: string, id: string, archivedAt: number): Promise<void>;
}
