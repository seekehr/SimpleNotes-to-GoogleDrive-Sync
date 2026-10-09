import type { RemoteCache } from "../state/types.js";

/**
 * Cloud-storage abstraction used by the sync engine. Google Drive is the only
 * implementation; another provider would implement this interface.
 *
 * Every file the app uploads is tagged with the Simplenote note ID (and the hashes
 * it was produced from), so files can be re-linked even if local state is lost.
 */
export interface RemoteFile {
  id: string;
  name: string;
  /** Note ID tag, when the file was uploaded by this app. */
  noteId?: string;
  contentHash?: string;
  renderFingerprint?: string;
  trashed: boolean;
  parents: string[];
  modifiedTime?: string;
}

export interface UploadInput {
  noteId: string;
  name: string;
  data: Buffer;
  mimeType: string;
  contentHash: string;
  renderFingerprint: string;
}

export interface UpdateInput {
  noteId: string;
  name: string;
  /** New contents. Omit for a metadata-only update (e.g. rename). */
  data?: Buffer;
  mimeType: string;
  contentHash: string;
  renderFingerprint: string;
  /** Untrash the file if it is in the trash. */
  restore?: boolean;
  /** Move the file back into the sync folder (e.g. out of the archive folder). */
  moveIntoFolder?: boolean;
}

export interface PrepareResult {
  cache: RemoteCache;
  /** False only in dry-run when the destination folder does not exist yet. */
  folderExists: boolean;
  folderDescription: string;
}

export interface RemoteStore {
  readonly providerName: string;
  /** Resolves (and outside dry-run, creates) the destination folder. Must be called first. */
  prepare(cache: RemoteCache, options: { dryRun: boolean }): Promise<PrepareResult>;
  /** All non-trashed files in the destination folder that carry a note ID tag. */
  listManagedFiles(): Promise<RemoteFile[]>;
  /** A single file by ID, or undefined if it no longer exists / is inaccessible. */
  getFile(fileId: string): Promise<RemoteFile | undefined>;
  createFile(input: UploadInput): Promise<RemoteFile>;
  updateFile(fileId: string, input: UpdateInput): Promise<RemoteFile>;
  trashFile(fileId: string): Promise<void>;
  /** Permanent deletion. Only used with `sync.deleted_notes: delete`. */
  deleteFile(fileId: string): Promise<void>;
  archiveFile(fileId: string): Promise<void>;
  /** Folder IDs resolved so far, to be persisted in sync state. */
  getCache(): RemoteCache;
  /** True if the given file sits in the sync folder (vs. archive or elsewhere). */
  isInSyncFolder(file: RemoteFile): boolean;
}
