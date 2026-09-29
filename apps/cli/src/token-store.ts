/** Where `clark-market login` keeps credentials, keyed by API origin so staging and production never mix. */
export interface StoredCredential {
  token: string;
  /** How it was obtained: `device` (login) or `api_token` (pasted personal token). */
  kind: "device" | "api_token";
  savedAt: string;
}

export interface TokenStore {
  get(apiUrl: string): Promise<StoredCredential | null>;
  set(apiUrl: string, credential: StoredCredential): Promise<void>;
  /** Returns whether a credential was removed. */
  delete(apiUrl: string): Promise<boolean>;
  /** Human-readable location, for messages. */
  readonly location: string;
}

/** In-memory store (tests, or when no config directory is writable). */
export class MemoryTokenStore implements TokenStore {
  readonly location = "memory";
  private readonly entries = new Map<string, StoredCredential>();

  async get(apiUrl: string) {
    return this.entries.get(apiUrl) ?? null;
  }

  async set(apiUrl: string, credential: StoredCredential) {
    this.entries.set(apiUrl, credential);
  }

  async delete(apiUrl: string) {
    return this.entries.delete(apiUrl);
  }
}
