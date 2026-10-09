import { readFileSync, unlinkSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { LockError } from "../errors.js";
import { ensureDir } from "../util/fs.js";

interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  token: string;
}

export interface Lock {
  release(): Promise<void>;
}

/** A lock older than this is considered abandoned even if its PID now belongs to another process. */
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists but owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockInfo;
  } catch {
    return undefined;
  }
}

/**
 * Cross-process lock using an exclusively-created file, so two runs started at
 * the same time (e.g. in two terminals) never sync concurrently.
 * Locks left by a crashed process are detected (dead PID or too old) and taken over.
 */
export async function acquireLock(path: string, options: { staleMs?: number } = {}): Promise<Lock> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  await ensureDir(dirname(path));
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify(info));
      await handle.close();
      return createLock(path, info.token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readLock(path);
    const age = existing ? Date.now() - Date.parse(existing.startedAt) : Number.POSITIVE_INFINITY;
    const sameHost = existing?.hostname === info.hostname;
    const alive = existing !== undefined && sameHost && processAlive(existing.pid);
    if (alive && age < staleMs) {
      throw new LockError(
        `Another synchronization is already running (pid ${existing.pid}, started ${existing.startedAt})`,
        { hint: `If you are sure no other notesync process is running, delete ${path}.` },
      );
    }
    if (existing && !sameHost && age < staleMs) {
      throw new LockError(`Sync lock is held by host ${existing.hostname} (started ${existing.startedAt})`);
    }
    // Stale: owner is gone or the lock is ancient. Remove and retry once.
    await rm(path, { force: true });
  }
  throw new LockError(`Could not acquire sync lock ${path}`);
}

function createLock(path: string, token: string): Lock {
  let released = false;
  const releaseSync = () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
      if (current.token === token) unlinkSync(path);
    } catch {
      // Already gone.
    }
  };
  // Make sure an interrupted process (Ctrl+C, normal exit) does not leave the lock behind.
  process.once("exit", releaseSync);
  return {
    async release() {
      process.removeListener("exit", releaseSync);
      releaseSync();
    },
  };
}

/** Reads the current lock holder without acquiring, for `status`. */
export async function inspectLock(path: string): Promise<(LockInfo & { alive: boolean }) | undefined> {
  const info = await readLock(path);
  if (!info) return undefined;
  return { ...info, alive: info.hostname === hostname() && processAlive(info.pid) };
}
