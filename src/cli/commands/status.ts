import type { ResolvedConfig } from "../../config/load.js";
import { loadClientCredentials, tokenStoreFor } from "../../drive/auth.js";
import { errorMessage } from "../../errors.js";
import type { Logger } from "../../logging/logger.js";
import { inspectLock } from "../../state/lock.js";
import { StateRepository } from "../../state/stateRepository.js";
import { formatDuration } from "../../util/duration.js";
import { print } from "../output.js";

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "never");
const line = (label: string, value: string) => print(`${`${label}:`.padEnd(20)}${value}`);

export async function runStatus(config: ResolvedConfig, logger: Logger, options: { json: boolean }): Promise<number> {
  const repo = new StateRepository(config.state.file, logger);
  let state;
  try {
    state = await repo.peek();
  } catch (error) {
    print(`State file problem: ${errorMessage(error)}`);
    return 1;
  }
  const lock = await inspectLock(config.state.lock_file);

  let auth = "not signed in";
  try {
    const credentials = await loadClientCredentials(config.google_drive.credentials_file);
    const store = await tokenStoreFor(config.google_drive, credentials, logger);
    const token = await store.load();
    if (token && token.client_id === credentials.clientId) auth = `signed in (token in ${store.description})`;
  } catch (error) {
    auth = errorMessage(error);
  }

  const entries = Object.values(state?.notes ?? {});
  const synced = entries.filter((e) => e.status === "synced");
  const deleted = entries.filter((e) => e.status === "deleted");

  if (options.json) {
    print(
      JSON.stringify(
        {
          lastRun: state?.lastRun ?? null,
          lastSuccessAt: state?.lastSuccessAt ?? null,
          notesTracked: synced.length,
          notesDeleted: deleted.length,
          remote: state?.remote ?? {},
          running: lock?.alive ? { pid: lock.pid, startedAt: lock.startedAt } : null,
          auth,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const last = state?.lastRun;
  line("Last run", last ? `${when(last.finishedAt)} — ${last.outcome} (${formatDuration(last.durationMs)})` : "never");
  if (last?.error) line("Last error", last.error);
  line("Last full success", when(state?.lastSuccessAt));
  if (last?.counts) {
    const c = last.counts;
    line("Last run counts", `new ${c.new ?? 0}, updated ${c.updated ?? 0}, unchanged ${c.unchanged ?? 0}, deleted ${c.deleted ?? 0}, failed ${c.failed ?? 0}`);
  }
  line("Notes tracked", `${synced.length}${deleted.length ? ` (+${deleted.length} deleted in Simplenote)` : ""}`);
  line(
    "Drive folder",
    state?.remote.folderId ? `${state.remote.folderKey ?? ""} (id ${state.remote.folderId})` : config.google_drive.folder_id || `My Drive/${config.google_drive.folder_path} (not resolved yet)`,
  );
  line("Google Drive", auth);
  line("Sync in progress", lock?.alive ? `yes (pid ${lock.pid} since ${when(lock.startedAt)})` : lock ? "no (stale lock file will be cleared)" : "no");
  line("Deleted notes", config.sync.deleted_notes);
  line("State file", config.state.file);

  if (last?.failures.length) {
    print("");
    print("Failures in last run:");
    for (const f of last.failures) {
      print(`- "${f.title}"`);
      print(`  ${f.error}`);
    }
  }
  return 0;
}
