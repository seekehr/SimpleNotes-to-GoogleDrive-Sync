import { randomBytes } from "node:crypto";
import { copyFile, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/load.js";
import type { DocumentRenderer } from "../docx/converter.js";
import type { RemoteFile, RemoteStore } from "../drive/remoteStore.js";
import { AppError, GoogleDriveAuthenticationError, StateFileError, errorMessage } from "../errors.js";
import type { Logger } from "../logging/logger.js";
import type { Note } from "../notes/note.js";
import type { FetchResult, NoteSource } from "../notes/source.js";
import { acquireLock, type Lock } from "../state/lock.js";
import type { StateRepository } from "../state/stateRepository.js";
import type { NoteState, RunRecord, SyncState } from "../state/types.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { formatDuration } from "../util/duration.js";
import { TEMP_SUFFIX, ensureDir, removeStaleTempFiles } from "../util/fs.js";
import { withRetry } from "../util/retry.js";
import { type ChangeReason, assessChange, contentHash } from "./changeDetector.js";
import { allocateFilenames } from "./filenames.js";
import { titleMatcher } from "./titleFilter.js";
import type { DeletionOutcome, NoteActionKind, NoteOutcome, SyncOptions, SyncReport } from "./types.js";

const STALE_TEMP_MS = 60 * 60 * 1000;

export interface SyncEngineDeps {
  config: ResolvedConfig;
  source: NoteSource;
  renderer: DocumentRenderer;
  /** Factory so Drive auth only happens once a sync actually needs it. */
  remote: () => Promise<RemoteStore>;
  stateRepository: StateRepository;
  logger: Logger;
  now?: () => Date;
}

interface PlannedNote {
  note: Note;
  filename: string;
  hash: string;
  action: NoteActionKind;
  reasons: ChangeReason[];
  needsContent: boolean;
  remoteFileId?: string;
  restore: boolean;
  moveIntoFolder: boolean;
  previous?: NoteState;
}

const toErrorInfo = (error: unknown) => ({
  message: errorMessage(error),
  code: error instanceof AppError ? error.code : "UNEXPECTED",
  hint: error instanceof AppError ? error.hint : undefined,
});

/**
 * Orchestrates one synchronization:
 *   scraper → filenames → change detection vs. state and Drive → render → upload → state
 *
 * Invariants:
 *  - a note's state entry is written only after its upload succeeded;
 *  - one note's failure never stops the others (auth failures stop the run: every
 *    later request would fail the same way);
 *  - nothing is deleted when the note listing may be incomplete.
 */
export class SyncEngine {
  private readonly now: () => Date;

  constructor(private readonly deps: SyncEngineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get config() {
    return this.deps.config;
  }

  private get logger() {
    return this.deps.logger;
  }

  async run(options: SyncOptions): Promise<SyncReport> {
    let lock: Lock | undefined;
    if (!options.dryRun) lock = await acquireLock(this.config.state.lock_file);
    try {
      return await this.runLocked(options);
    } finally {
      await lock?.release();
    }
  }

  private async runLocked(options: SyncOptions): Promise<SyncReport> {
    const startedAt = this.now();
    const started = performance.now();
    const { dryRun } = options;
    const force = options.force || this.config.sync.upload_unchanged;
    this.logger.info(dryRun ? "Starting synchronization (dry run)" : "Starting synchronization");

    await this.cleanupTemp();
    const { state, source: stateSource } = await this.deps.stateRepository.load();
    if (stateSource !== "file" && stateSource !== "new") this.logger.warn("Sync state was recovered", { source: stateSource });

    const report: SyncReport = {
      dryRun,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      folder: "",
      counts: { discovered: 0, filtered: 0, new: 0, updated: 0, renamed: 0, unchanged: 0, deleted: 0, failed: 0, duplicates: 0 },
      notes: [],
      deletions: [],
      deletionsSkipped: 0,
      duplicates: [],
      warnings: [],
      aborted: false,
    };

    try {
      const fetched = await this.fetchNotes();
      report.warnings.push(...fetched.warnings);
      report.counts.discovered = fetched.notes.length + fetched.failures.length;

      // Notes outside the title filter are ignored completely. They stay in `fetched`
      // so that handleDeletions still sees them as present and never deletes them.
      const matches = titleMatcher(this.config.sync.title_keywords);
      const notes = fetched.notes.filter((n) => matches(n.title));
      const failures = fetched.failures.filter((f) => matches(f.title));
      report.counts.filtered = report.counts.discovered - notes.length - failures.length;
      if (report.counts.filtered > 0) {
        this.logger.info("Skipped notes not matching sync.title_keywords", { count: report.counts.filtered });
      }

      for (const failure of failures) {
        report.notes.push({
          id: failure.id,
          title: failure.title,
          filename: state.notes[failure.id]?.filename ?? "",
          action: "update",
          reasons: [],
          status: "failed",
          error: toErrorInfo(failure.error),
        });
        this.logger.error("Note could not be read from scraper output", { title: failure.title, error: failure.error });
      }

      const remote = await this.prepareRemote(state, dryRun, report);
      const listing = remote.store && remote.folderExists ? await remote.store.listManagedFiles() : [];
      const remoteByNote = new Map<string, RemoteFile[]>();
      for (const file of listing) {
        if (!file.noteId) continue;
        remoteByNote.set(file.noteId, [...(remoteByNote.get(file.noteId) ?? []), file]);
      }

      const failedIds = new Set(fetched.failures.map((f) => f.id));
      const filenames = allocateFilenames(notes, state.notes, this.deps.renderer.extension, failedIds);
      const plans = await this.plan(notes, filenames, state, remote.store, remoteByNote, force, report);

      await this.execute(plans, state, remote.store, filenames, options, report);
      await this.handleDeletions(fetched, failedIds, state, remote.store, filenames, options, report);
      await this.handleDuplicates(remote.store, remoteByNote, state, dryRun, report);

      if (remote.store && !dryRun) state.remote = remote.store.getCache();
      report.finishedAt = this.now();
      report.durationMs = performance.now() - started;
      if (!dryRun) {
        state.lastRun = this.runRecord(report);
        if (report.counts.failed === 0 && !report.aborted) state.lastSuccessAt = report.finishedAt.toISOString();
        await this.deps.stateRepository.save(state);
      }
      this.logger.info(dryRun ? "Dry run complete" : "Synchronization complete", {
        new: report.counts.new,
        updated: report.counts.updated,
        renamed: report.counts.renamed,
        unchanged: report.counts.unchanged,
        deleted: report.counts.deleted,
        failed: report.counts.failed,
        duration: formatDuration(report.durationMs),
      });
      return report;
    } catch (error) {
      report.finishedAt = this.now();
      report.durationMs = performance.now() - started;
      this.logger.error("Synchronization failed", { error, duration: formatDuration(report.durationMs) });
      if (!dryRun && !(error instanceof StateFileError)) {
        // Best effort: record the failure for `notesync status` without masking the original error.
        state.lastRun = { ...this.runRecord(report), outcome: "failed", error: errorMessage(error) };
        await this.deps.stateRepository.save(state).catch(() => undefined);
      }
      throw error;
    }
  }

  private runRecord(report: SyncReport): RunRecord {
    return {
      startedAt: report.startedAt.toISOString(),
      finishedAt: report.finishedAt.toISOString(),
      outcome: report.dryRun ? "dry-run" : report.counts.failed > 0 || report.aborted ? "partial" : "success",
      durationMs: Math.round(report.durationMs),
      counts: { ...report.counts },
      failures: report.notes
        .filter((n) => n.status === "failed")
        .map((n) => ({ id: n.id, title: n.title, error: n.error?.message ?? "unknown error" })),
    };
  }

  private async cleanupTemp(): Promise<void> {
    const removed =
      (await removeStaleTempFiles(this.config.output.temp_directory, STALE_TEMP_MS)) +
      (await removeStaleTempFiles(this.config.output.generated_directory, STALE_TEMP_MS)) +
      (await removeStaleTempFiles(this.config.state.file.replace(/[\\/][^\\/]*$/, ""), STALE_TEMP_MS));
    if (removed > 0) this.logger.info("Removed stale temporary files from an interrupted run", { count: removed });
  }

  private async fetchNotes(): Promise<FetchResult> {
    const r = this.config.retry;
    return withRetry(() => this.deps.source.fetchNotes(), {
      attempts: Math.min(r.attempts, 3),
      initialDelayMs: r.initial_delay_seconds * 1000,
      maxDelayMs: r.max_delay_seconds * 1000,
      onRetry: ({ error, attempt, delayMs }) =>
        this.logger.warn("Scraper run failed; retrying", { attempt, delay_ms: delayMs, error }),
    });
  }

  private async prepareRemote(
    state: SyncState,
    dryRun: boolean,
    report: SyncReport,
  ): Promise<{ store?: RemoteStore; folderExists: boolean }> {
    try {
      const store = await this.deps.remote();
      const prepared = await store.prepare(state.remote, { dryRun });
      report.folder = `${store.providerName}: ${prepared.folderDescription}`;
      return { store, folderExists: prepared.folderExists };
    } catch (error) {
      if (dryRun && error instanceof GoogleDriveAuthenticationError) {
        const message = `Google Drive not checked (${error.message}); plan is based on local state only`;
        this.logger.warn(message);
        report.warnings.push(message);
        report.folder = "Google Drive (not connected)";
        return { folderExists: false };
      }
      throw error;
    }
  }

  /** Decides, per note, whether it is new, changed, renamed or unchanged — consulting Drive where state is unsure. */
  private async plan(
    notes: Note[],
    filenames: Map<string, string>,
    state: SyncState,
    store: RemoteStore | undefined,
    remoteByNote: Map<string, RemoteFile[]>,
    force: boolean,
    report: SyncReport,
  ): Promise<PlannedNote[]> {
    const fingerprint = this.deps.renderer.fingerprint();
    const includeMetadata = this.config.document.include_metadata;
    const plans: PlannedNote[] = [];

    for (const note of notes) {
      const filename = filenames.get(note.id) as string;
      const hash = contentHash(note, includeMetadata);
      const previous = state.notes[note.id];
      const candidates = remoteByNote.get(note.id) ?? [];
      let remoteFileId = previous?.remoteFileId;
      let restore = false;
      let moveIntoFolder = false;
      const extraReasons: ChangeReason[] = [];
      let effectivePrevious = previous;

      if (store) {
        if (remoteFileId && !candidates.some((c) => c.id === remoteFileId)) {
          // The mapped file is not in the sync folder: deleted, trashed, archived or moved.
          const file = await store.getFile(remoteFileId);
          if (!file) {
            remoteFileId = undefined;
            effectivePrevious = undefined;
          } else if (file.trashed) {
            if (this.config.sync.restore_missing_remote || previous?.status === "deleted") {
              restore = true;
              extraReasons.push("remote-missing");
            }
          } else if (previous?.status === "deleted") {
            moveIntoFolder = true; // Note was restored in Simplenote: bring it back from the archive.
            extraReasons.push("remote-missing");
          }
        }
        if (!remoteFileId && candidates.length > 0) {
          // No usable mapping (state lost, or a crash after upload): re-link the tagged file.
          const adopted = [...candidates].sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""))[0] as RemoteFile;
          remoteFileId = adopted.id;
          effectivePrevious = {
            title: note.title,
            filename: adopted.name,
            contentHash: adopted.contentHash ?? "",
            renderFingerprint: adopted.renderFingerprint ?? "",
            tags: note.tags,
            remoteFileId: adopted.id,
            lastSynced: adopted.modifiedTime ?? "",
            status: "synced",
          };
          extraReasons.push("recovered");
          this.logger.info("Re-linked existing Drive file to note", { title: note.title, drive_file_id: adopted.id });
        }
        if (!remoteFileId && previous?.remoteFileId) {
          if (!this.config.sync.restore_missing_remote && previous.status === "synced") {
            // Respect the user's removal: leave state pointing at the missing file and do nothing.
            report.warnings.push(`"${note.title}": Drive file was removed and restore_missing_remote is off; not re-uploading`);
            plans.push({
              note,
              filename,
              hash,
              action: "unchanged",
              reasons: [],
              needsContent: false,
              remoteFileId: previous.remoteFileId,
              restore: false,
              moveIntoFolder: false,
              previous,
            });
            continue;
          }
          extraReasons.push("remote-missing");
        }
      }

      const base = assessChange(
        effectivePrevious && remoteFileId ? { ...effectivePrevious, remoteFileId } : undefined,
        hash,
        fingerprint,
        filename,
        force,
      );
      const reasons = [...new Set([...base.reasons, ...extraReasons])];
      const needsContent = base.needsContent || restore || moveIntoFolder || (reasons.includes("remote-missing") && !remoteFileId);
      let action: NoteActionKind;
      if (!remoteFileId) action = "create";
      else if (needsContent) action = "update";
      else if (reasons.includes("rename")) action = "rename";
      else action = "unchanged";

      plans.push({
        note,
        filename,
        hash,
        action,
        reasons: action === "unchanged" ? reasons.filter((r) => r === "recovered") : reasons,
        needsContent: action === "create" || needsContent,
        remoteFileId,
        restore,
        moveIntoFolder,
        previous,
      });
    }
    return plans;
  }

  private async execute(
    plans: PlannedNote[],
    state: SyncState,
    store: RemoteStore | undefined,
    filenames: Map<string, string>,
    options: SyncOptions,
    report: SyncReport,
  ): Promise<void> {
    const assigned = new Set([...filenames.values()].map((f) => f.toLowerCase()));
    let authFailure: AppError | undefined;
    const fingerprint = this.deps.renderer.fingerprint();

    const results = await mapWithConcurrency(plans, this.config.sync.max_concurrent_uploads, async (plan) => {
      const outcome: NoteOutcome = {
        id: plan.note.id,
        title: plan.note.title,
        filename: plan.filename,
        action: plan.action,
        reasons: plan.reasons,
        status: options.dryRun ? "planned" : "done",
        previousFilename: plan.previous && plan.previous.filename !== plan.filename ? plan.previous.filename : undefined,
        remoteFileId: plan.remoteFileId,
      };
      const log = this.logger.child({ title: plan.note.title });

      if (plan.action === "unchanged") {
        log.debug("Note unchanged");
        if (!options.dryRun) this.recordState(state, plan, plan.remoteFileId as string, fingerprint, plan.reasons.includes("recovered"));
        return outcome;
      }
      if (authFailure || options.signal?.aborted) {
        outcome.status = "skipped";
        outcome.error = authFailure
          ? { message: "Skipped: Google authentication failed earlier in this run", code: authFailure.code }
          : { message: "Skipped: synchronization was interrupted", code: "ABORTED" };
        return outcome;
      }

      try {
        let data: Buffer | undefined;
        if (plan.needsContent) {
          const rendered = await this.deps.renderer.render(plan.note);
          data = rendered.data;
          if (rendered.warnings.length) {
            outcome.warnings = rendered.warnings;
            for (const warning of rendered.warnings) log.warn(warning);
          }
          log.info(options.dryRun ? "Converted note (dry run)" : "Converted note", { bytes: data.length });
        }
        if (options.dryRun || !store) return outcome;

        const staged = data ? await this.stage(plan.note.id, data) : undefined;
        try {
          const input = {
            noteId: plan.note.id,
            name: plan.filename,
            mimeType: this.deps.renderer.mimeType,
            contentHash: plan.hash,
            renderFingerprint: fingerprint,
          };
          const file = plan.remoteFileId
            ? await store.updateFile(plan.remoteFileId, {
                ...input,
                data,
                restore: plan.restore,
                moveIntoFolder: plan.moveIntoFolder,
              })
            : await store.createFile({ ...input, data: data as Buffer });
          outcome.remoteFileId = file.id;

          // Upload succeeded: only now does the note count as synchronized.
          this.recordState(state, plan, file.id, fingerprint, true);
          await this.deps.stateRepository.save(state);

          if (staged) await this.publishLocal(staged, plan, assigned);
          else if (outcome.previousFilename) await this.renameLocal(outcome.previousFilename, plan.filename, assigned);
        } finally {
          if (staged) await rm(staged, { force: true });
        }
        const verb = plan.action === "create" ? "Uploaded document" : plan.action === "rename" ? "Renamed document" : "Updated document";
        log.info(verb, { drive_file_id: outcome.remoteFileId, reasons: plan.reasons.join(",") });
        return outcome;
      } catch (error) {
        if (error instanceof GoogleDriveAuthenticationError) authFailure = error;
        outcome.status = "failed";
        outcome.error = toErrorInfo(error);
        log.error("Note synchronization failed", { error });
        return outcome;
      }
    });

    for (const result of results) {
      // Workers never throw, but keep the report correct if one ever does.
      const outcome: NoteOutcome =
        result.status === "fulfilled"
          ? result.value
          : { id: "?", title: "?", filename: "", action: "update", reasons: [], status: "failed", error: toErrorInfo(result.reason) };
      report.notes.push(outcome);
    }

    if (options.signal?.aborted) report.aborted = true;
    for (const outcome of report.notes) {
      if (outcome.status === "failed" || outcome.status === "skipped") {
        report.counts.failed++;
        continue;
      }
      if (outcome.action === "create") report.counts.new++;
      else if (outcome.action === "update") report.counts.updated++;
      else if (outcome.action === "rename") report.counts.renamed++;
      else report.counts.unchanged++;
    }
    if (authFailure) throw authFailure;
  }

  private recordState(state: SyncState, plan: PlannedNote, fileId: string, fingerprint: string, synced: boolean): void {
    const previous = state.notes[plan.note.id];
    const note = plan.note;
    state.notes[note.id] = {
      ...(previous ?? {}),
      title: note.title,
      filename: plan.filename,
      contentHash: synced || !previous ? plan.hash : previous.contentHash,
      renderFingerprint: synced || !previous ? fingerprint : previous.renderFingerprint,
      revision: note.revision,
      tags: note.tags,
      createdAt: note.createdAt?.toISOString(),
      updatedAt: note.updatedAt?.toISOString(),
      remoteFileId: fileId,
      lastSynced: synced ? this.now().toISOString() : (previous?.lastSynced ?? this.now().toISOString()),
      status: "synced",
      deletedAt: undefined,
      deletionAction: undefined,
    };
  }

  /** Writes the generated document to the temp directory before upload (crash-safe staging). */
  private async stage(noteId: string, data: Buffer): Promise<string> {
    const dir = this.config.output.temp_directory;
    await ensureDir(dir);
    const path = join(dir, `${noteId.replace(/[^\w-]/g, "_")}-${randomBytes(4).toString("hex")}${this.deps.renderer.extension}${TEMP_SUFFIX}`);
    const handle = await open(path, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  }

  /** Moves a staged document into the local output folder (if enabled) and removes a stale old name. */
  private async publishLocal(staged: string, plan: PlannedNote, assigned: Set<string>): Promise<void> {
    if (!this.config.output.keep_local_docx) return;
    const dir = this.config.output.generated_directory;
    try {
      await ensureDir(dir);
      const target = join(dir, plan.filename);
      try {
        await rename(staged, target);
      } catch {
        await copyFile(staged, target); // e.g. temp and output on different drives
      }
      const old = plan.previous?.filename;
      if (old && old !== plan.filename && !assigned.has(old.toLowerCase())) await rm(join(dir, old), { force: true });
    } catch (error) {
      this.logger.warn("Could not save local copy of document", { filename: plan.filename, error });
    }
  }

  private async renameLocal(from: string, to: string, assigned: Set<string>): Promise<void> {
    if (!this.config.output.keep_local_docx || assigned.has(from.toLowerCase())) return;
    const dir = this.config.output.generated_directory;
    await rename(join(dir, from), join(dir, to)).catch(() => undefined);
  }

  private async handleDeletions(
    fetched: FetchResult,
    failedIds: Set<string>,
    state: SyncState,
    store: RemoteStore | undefined,
    filenames: Map<string, string>,
    options: SyncOptions,
    report: SyncReport,
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const present = new Set(fetched.notes.map((n) => n.id));
    const gone = Object.entries(state.notes).filter(
      ([id, entry]) => entry.status === "synced" && !present.has(id) && !failedIds.has(id),
    );
    if (gone.length === 0) return;

    if (!fetched.complete) {
      report.deletionsSkipped = gone.length;
      report.warnings.push(`${gone.length} note(s) missing from an incomplete listing; deletions skipped`);
      return;
    }
    const tracked = Object.values(state.notes).filter((e) => e.status === "synced").length;
    const ratio = gone.length / Math.max(tracked, 1);
    const suspicious = (fetched.notes.length === 0 && tracked > 0) || (gone.length >= 3 && ratio > this.config.sync.max_deletion_ratio);
    if (suspicious && !options.force && this.config.sync.deleted_notes !== "keep") {
      report.deletionsSkipped = gone.length;
      const message =
        `${gone.length} of ${tracked} notes disappeared at once (more than sync.max_deletion_ratio=${this.config.sync.max_deletion_ratio}); ` +
        "deletions skipped as a precaution. Run with --force to apply them.";
      report.warnings.push(message);
      this.logger.warn(message);
      return;
    }

    const policy = this.config.sync.deleted_notes;
    const assigned = new Set([...filenames.values()].map((f) => f.toLowerCase()));
    for (const [id, entry] of gone) {
      const outcome: DeletionOutcome = {
        id,
        title: entry.title,
        filename: entry.filename,
        policy,
        status: options.dryRun ? "planned" : "done",
      };
      report.deletions.push(outcome);
      if (options.dryRun) continue;
      try {
        if (entry.remoteFileId && store) {
          if (policy === "move_to_trash") await store.trashFile(entry.remoteFileId);
          else if (policy === "delete") await store.deleteFile(entry.remoteFileId);
          else if (policy === "archive") await store.archiveFile(entry.remoteFileId);
        }
        state.notes[id] = {
          ...entry,
          status: "deleted",
          deletedAt: this.now().toISOString(),
          deletionAction: policy,
          remoteFileId: policy === "delete" ? undefined : entry.remoteFileId,
        };
        await this.deps.stateRepository.save(state);
        if (policy !== "keep" && this.config.output.keep_local_docx && !assigned.has(entry.filename.toLowerCase())) {
          await rm(join(this.config.output.generated_directory, entry.filename), { force: true });
        }
        if (policy !== "keep") report.counts.deleted++;
        this.logger.info(policy === "keep" ? "Note deleted in Simplenote; keeping Drive file" : "Applied deletion policy", {
          title: entry.title,
          policy,
        });
      } catch (error) {
        outcome.status = "failed";
        outcome.error = toErrorInfo(error);
        report.counts.failed++;
        this.logger.error("Could not apply deletion policy", { title: entry.title, policy, error });
        if (error instanceof GoogleDriveAuthenticationError) throw error;
      }
    }
  }

  private async handleDuplicates(
    store: RemoteStore | undefined,
    remoteByNote: Map<string, RemoteFile[]>,
    state: SyncState,
    dryRun: boolean,
    report: SyncReport,
  ): Promise<void> {
    if (!store) return;
    for (const [noteId, files] of remoteByNote) {
      if (files.length < 2) continue;
      const keptFileId = state.notes[noteId]?.remoteFileId ?? files[0]?.id ?? "";
      const extras = files.filter((f) => f.id !== keptFileId).map((f) => f.id);
      if (extras.length === 0) continue;
      const trash = this.config.sync.duplicates === "trash" && !dryRun;
      report.counts.duplicates += extras.length;
      report.duplicates.push({ noteId, keptFileId, extraFileIds: extras, trashed: trash });
      this.logger.warn("Duplicate Drive files found for one note", {
        title: state.notes[noteId]?.title,
        kept: keptFileId,
        extras: extras.join(","),
        action: trash ? "trash" : "warn",
      });
      if (trash) {
        for (const id of extras) {
          await store.trashFile(id).catch((error) => this.logger.warn("Could not trash duplicate", { drive_file_id: id, error }));
        }
      }
    }
  }
}
