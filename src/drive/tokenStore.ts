import { readFile, rm } from "node:fs/promises";
import { GoogleDriveAuthenticationError, errorMessage } from "../errors.js";
import type { Logger } from "../logging/logger.js";
import { registerSecret } from "../logging/redact.js";
import { pathExists, writeFileAtomic } from "../util/fs.js";

/**
 * What is persisted. Only the long-lived refresh token and its scope are stored;
 * access tokens are short-lived and kept in memory only.
 */
export interface StoredToken {
  refresh_token: string;
  scope?: string;
  /** Client ID the token was issued to; a token for another client is ignored. */
  client_id: string;
  created_at: string;
}

export interface TokenStore {
  readonly description: string;
  load(): Promise<StoredToken | undefined>;
  save(token: StoredToken): Promise<void>;
  clear(): Promise<void>;
}

const KEYRING_SERVICE = "notesync-google-drive";

function parseToken(text: string, where: string): StoredToken | undefined {
  try {
    const data = JSON.parse(text) as Partial<StoredToken>;
    if (typeof data.refresh_token !== "string" || typeof data.client_id !== "string") return undefined;
    registerSecret(data.refresh_token);
    return data as StoredToken;
  } catch (error) {
    throw new GoogleDriveAuthenticationError(`Stored Google token in ${where} is unreadable: ${errorMessage(error)}`, {
      hint: 'Run "notesync auth" to sign in again.',
    });
  }
}

/** Windows Credential Manager (or macOS Keychain / libsecret) via @napi-rs/keyring. */
export class KeyringTokenStore implements TokenStore {
  readonly description = "Windows Credential Manager / OS keychain";

  private constructor(private readonly entry: { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean }) {}

  /** Returns undefined when no OS keyring is usable on this machine. */
  static async create(account: string): Promise<KeyringTokenStore | undefined> {
    try {
      const { Entry } = await import("@napi-rs/keyring");
      const entry = new Entry(KEYRING_SERVICE, account);
      entry.getPassword(); // Probe: throws if the backend is unavailable.
      return new KeyringTokenStore(entry);
    } catch {
      return undefined;
    }
  }

  async load(): Promise<StoredToken | undefined> {
    const text = this.entry.getPassword();
    return text ? parseToken(text, this.description) : undefined;
  }

  async save(token: StoredToken): Promise<void> {
    this.entry.setPassword(JSON.stringify(token));
  }

  async clear(): Promise<void> {
    try {
      this.entry.deletePassword();
    } catch {
      // Nothing stored.
    }
  }
}

/** Plain JSON file fallback. Keep it out of version control (already in .gitignore). */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  get description(): string {
    return `file ${this.path}`;
  }

  async load(): Promise<StoredToken | undefined> {
    if (!(await pathExists(this.path))) return undefined;
    return parseToken(await readFile(this.path, "utf8"), this.path);
  }

  async save(token: StoredToken): Promise<void> {
    await writeFileAtomic(this.path, JSON.stringify(token, null, 2));
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export async function createTokenStore(
  mode: "auto" | "keyring" | "file",
  tokenFile: string,
  account: string,
  logger: Logger,
): Promise<TokenStore> {
  if (mode === "file") return new FileTokenStore(tokenFile);
  const keyring = await KeyringTokenStore.create(account);
  if (keyring) return keyring;
  if (mode === "keyring") {
    throw new GoogleDriveAuthenticationError("OS credential storage is not available on this machine", {
      hint: 'Set google_drive.token_store to "file" or "auto".',
    });
  }
  logger.warn("OS credential storage unavailable; storing Google token in a file", { path: tokenFile });
  return new FileTokenStore(tokenFile);
}
