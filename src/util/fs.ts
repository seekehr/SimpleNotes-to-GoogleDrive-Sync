import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sleep } from "./retry.js";

/** Windows antivirus/indexers briefly lock freshly written files; these codes are worth a short retry. */
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export const TEMP_SUFFIX = ".snsync-tmp";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 6 || !TRANSIENT_FS_CODES.has(code)) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}

/**
 * Writes a file atomically: data goes to a sibling temp file which is fsynced and
 * then renamed over the target. A crash mid-write leaves either the old file or
 * the new one, never a truncated mix. Leftover temp files are swept by
 * `removeStaleTempFiles`.
 */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(target);
  await ensureDir(dir);
  const temp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}${TEMP_SUFFIX}`);
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Checks that a directory can be created, written and cleaned up. Returns an error message or undefined. */
export async function checkWritableDir(dir: string): Promise<string | undefined> {
  try {
    await ensureDir(dir);
    const probe = join(dir, `.write-probe-${process.pid}-${randomBytes(3).toString("hex")}`);
    await writeFileAtomic(probe, "ok");
    await unlink(probe);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Removes temp files left behind by an interrupted run. Only touches files carrying
 * our temp suffix that are older than `olderThanMs`, so a concurrently running
 * writer is never disturbed.
 */
export async function removeStaleTempFiles(dir: string, olderThanMs: number): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const name of entries) {
    if (!name.endsWith(TEMP_SUFFIX)) continue;
    const full = join(dir, name);
    try {
      if ((await stat(full)).mtimeMs < cutoff) {
        await rm(full, { force: true });
        removed++;
      }
    } catch {
      // Raced with another cleanup; ignore.
    }
  }
  return removed;
}
