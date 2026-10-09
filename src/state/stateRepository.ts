import { readFile, rename } from "node:fs/promises";
import { StateFileError, errorMessage } from "../errors.js";
import type { Logger } from "../logging/logger.js";
import { Mutex } from "../util/concurrency.js";
import { pathExists, writeFileAtomic } from "../util/fs.js";
import { STATE_VERSION, type SyncState, emptyState, syncStateSchema } from "./types.js";

export interface LoadResult {
  state: SyncState;
  /** How the state was obtained — surfaced in logs and `status`. */
  source: "file" | "backup" | "new" | "recovered-empty";
}

/**
 * Persists sync state as JSON with crash-safe writes:
 *  - every save is an atomic temp-file + fsync + rename;
 *  - after each successful load a `.bak` copy of the last good state is kept;
 *  - a corrupt file is moved aside (`.corrupt-<timestamp>`) and the backup is used.
 *
 * Losing state entirely is survivable: Drive files carry the note ID in
 * appProperties, so the next sync re-adopts them instead of uploading copies.
 */
export class StateRepository {
  private readonly mutex = new Mutex();

  constructor(
    readonly path: string,
    private readonly logger: Logger,
  ) {}

  get backupPath(): string {
    return `${this.path}.bak`;
  }

  private async parseFile(path: string): Promise<SyncState> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      // Unreadable (permissions, locked) is not corruption: never quarantine in that case.
      throw new StateFileError(`Cannot read state file ${path}: ${errorMessage(error)}`, {
        cause: error,
        details: { fatal: true },
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new StateFileError(`State file ${path} is not valid JSON: ${errorMessage(error)}`, { cause: error });
    }
    const version = (json as { version?: unknown })?.version;
    if (typeof version === "number" && version > STATE_VERSION) {
      // Never "repair" a file written by a newer version — that would destroy its data.
      throw new StateFileError(
        `State file ${path} has version ${version}, newer than this application supports (${STATE_VERSION})`,
        { hint: "Upgrade notesync, or point state.file at a different location.", details: { fatal: true } },
      );
    }
    const parsed = syncStateSchema.safeParse(json);
    if (!parsed.success) {
      throw new StateFileError(`State file ${path} has an unexpected structure: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    return parsed.data;
  }

  private isFatal(error: unknown): boolean {
    return error instanceof StateFileError && error.details?.fatal === true;
  }

  async load(): Promise<LoadResult> {
    if (!(await pathExists(this.path))) {
      if (await pathExists(this.backupPath)) {
        // Only the backup survived (e.g. the main file was deleted by hand).
        try {
          const state = await this.parseFile(this.backupPath);
          this.logger.warn("State file missing; restored from backup", { path: this.backupPath });
          return { state, source: "backup" };
        } catch (error) {
          if (this.isFatal(error)) throw error;
        }
      }
      return { state: emptyState(), source: "new" };
    }

    try {
      const state = await this.parseFile(this.path);
      await writeFileAtomic(this.backupPath, JSON.stringify(state, null, 2)).catch((error) =>
        this.logger.warn("Could not refresh state backup", { error }),
      );
      return { state, source: "file" };
    } catch (error) {
      if (this.isFatal(error)) throw error;
      const quarantine = `${this.path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      this.logger.error("State file is corrupt; moving it aside", { path: this.path, moved_to: quarantine, error });
      try {
        await rename(this.path, quarantine);
      } catch (renameError) {
        throw new StateFileError(`State file is corrupt and could not be moved aside: ${errorMessage(renameError)}`, {
          cause: error,
        });
      }
      if (await pathExists(this.backupPath)) {
        try {
          const state = await this.parseFile(this.backupPath);
          this.logger.warn("Recovered sync state from backup", { path: this.backupPath });
          return { state, source: "backup" };
        } catch (backupError) {
          this.logger.error("State backup is also unreadable", { error: backupError });
        }
      }
      this.logger.warn("Starting with empty state; existing Drive files will be re-linked by note ID");
      return { state: emptyState(), source: "recovered-empty" };
    }
  }

  /** Read-only load for `status` / `doctor`: never quarantines or rewrites anything. */
  async peek(): Promise<SyncState | undefined> {
    if (!(await pathExists(this.path))) return undefined;
    return this.parseFile(this.path);
  }

  /** Atomically persists the state. Concurrent calls are serialized. */
  save(state: SyncState): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    return this.mutex.run(async () => {
      try {
        await writeFileAtomic(this.path, snapshot);
      } catch (error) {
        throw new StateFileError(`Could not write state file ${this.path}: ${errorMessage(error)}`, { cause: error });
      }
    });
  }
}
