import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { StoredCredential, TokenStore } from "./token-store";

const APP_DIR = "clark-market";
const FILE_NAME = "credentials.json";

/**
 * The OS config directory: `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME`
 * (default `~/.config`) elsewhere. `CLARK_MARKET_CONFIG_DIR` overrides it (tests, portable installs).
 */
export function defaultConfigDir(env: Record<string, string | undefined>, platform: string = process.platform): string {
  if (env.CLARK_MARKET_CONFIG_DIR) return env.CLARK_MARKET_CONFIG_DIR;
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), APP_DIR);
  if (platform === "darwin") return path.join(homedir(), "Library", "Application Support", APP_DIR);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), APP_DIR);
}

type CredentialFile = Record<string, StoredCredential>;

function isCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.token === "string" && (entry.kind === "device" || entry.kind === "api_token") && typeof entry.savedAt === "string";
}

/**
 * Credentials as JSON in the config directory. The directory is created `0700` and the file written `0600` (then
 * re-`chmod`ed, since an existing file keeps its mode), through a temp file and rename so a crash never leaves a
 * truncated file. Windows ignores POSIX modes; the file lives in the user's own profile there.
 */
export class FileTokenStore implements TokenStore {
  readonly location: string;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.location = path.join(dir, FILE_NAME);
  }

  private async read(): Promise<CredentialFile> {
    let text: string;
    try {
      text = await readFile(this.location, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${this.location} is not valid JSON; delete it and log in again`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isCredential(value))) as CredentialFile;
  }

  private async write(entries: CredentialFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.location}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.location);
  }

  async get(apiUrl: string) {
    return (await this.read())[apiUrl] ?? null;
  }

  async set(apiUrl: string, credential: StoredCredential) {
    const entries = await this.read();
    entries[apiUrl] = credential;
    await this.write(entries);
  }

  async delete(apiUrl: string) {
    const entries = await this.read();
    if (!(apiUrl in entries)) return false;
    delete entries[apiUrl];
    await this.write(entries);
    return true;
  }
}
