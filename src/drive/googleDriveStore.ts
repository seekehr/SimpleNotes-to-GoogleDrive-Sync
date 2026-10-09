import { Readable } from "node:stream";
import { drive as createDrive, type drive_v3 } from "@googleapis/drive";
import type { OAuth2Client } from "google-auth-library";
import { AppError, GoogleDriveError, errorMessage } from "../errors.js";
import type { Logger } from "../logging/logger.js";
import type { RemoteCache } from "../state/types.js";
import { type RetryPolicy, withRetry } from "../util/retry.js";
import type { DriveSettings } from "./auth.js";
import { classifyDriveError, isNotFound } from "./errors.js";
import type { PrepareResult, RemoteFile, RemoteStore, UpdateInput, UploadInput } from "./remoteStore.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,trashed,parents,modifiedTime,mimeType,appProperties";

/** appProperties keys. Private to this OAuth client; invisible to other apps. */
export const PROP_NOTE_ID = "snsyncNoteId";
export const PROP_HASH = "snsyncHash";
export const PROP_RENDER = "snsyncRender";

/** Escapes a value for a Drive `q` string literal. */
export const escapeQuery = (value: string): string => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function toRemoteFile(file: drive_v3.Schema$File): RemoteFile {
  const props = file.appProperties ?? {};
  return {
    id: file.id ?? "",
    name: file.name ?? "",
    noteId: props[PROP_NOTE_ID] ?? undefined,
    contentHash: props[PROP_HASH] ?? undefined,
    renderFingerprint: props[PROP_RENDER] ?? undefined,
    trashed: Boolean(file.trashed),
    parents: file.parents ?? [],
    modifiedTime: file.modifiedTime ?? undefined,
  };
}

export interface GoogleDriveStoreOptions {
  settings: DriveSettings;
  retry: RetryPolicy;
  logger: Logger;
  /** Injected for tests; defaults to the real Drive v3 client. */
  api?: drive_v3.Drive;
  auth?: OAuth2Client;
}

export class GoogleDriveStore implements RemoteStore {
  readonly providerName = "Google Drive";
  private readonly api: drive_v3.Drive;
  private readonly settings: DriveSettings;
  private readonly retry: RetryPolicy;
  private readonly logger: Logger;
  private folderId?: string;
  private cache: RemoteCache = {};
  private readonly requestOptions: { retry: false; timeout: number };

  constructor(options: GoogleDriveStoreOptions) {
    this.settings = options.settings;
    this.retry = options.retry;
    this.logger = options.logger;
    this.api = options.api ?? createDrive({ version: "v3", auth: options.auth });
    // Retries are handled by withRetry so every call shares one policy and log trail.
    this.requestOptions = { retry: false, timeout: options.settings.request_timeout_seconds * 1000 };
  }

  private call<T>(operation: string, fn: (attempt: number) => Promise<T>, kind: "upload" | "other" = "other"): Promise<T> {
    return withRetry(
      async (attempt) => {
        try {
          return await fn(attempt);
        } catch (error) {
          throw classifyDriveError(error, operation, kind);
        }
      },
      {
        ...this.retry,
        onRetry: ({ error, attempt, delayMs }) =>
          this.logger.warn("Retrying Google Drive request", {
            operation,
            attempt,
            delay_ms: delayMs,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  private requireFolder(): string {
    if (!this.folderId) throw new GoogleDriveError("Drive folder not resolved; prepare() must run first");
    return this.folderId;
  }

  getCache(): RemoteCache {
    return { ...this.cache };
  }

  isInSyncFolder(file: RemoteFile): boolean {
    return this.folderId !== undefined && file.parents.includes(this.folderId);
  }

  async getFile(fileId: string): Promise<RemoteFile | undefined> {
    try {
      const res = await this.call("files.get", () =>
        this.api.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true }, this.requestOptions),
      );
      return toRemoteFile(res.data);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async findChildFolder(parentId: string, name: string): Promise<string | undefined> {
    const res = await this.call("files.list(folder)", () =>
      this.api.files.list(
        {
          q: `name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and '${escapeQuery(parentId)}' in parents and trashed = false`,
          fields: "files(id,name,createdTime)",
          orderBy: "createdTime",
          pageSize: 10,
          spaces: "drive",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
        this.requestOptions,
      ),
    );
    const folders = res.data.files ?? [];
    if (folders.length > 1) {
      this.logger.warn("Multiple Drive folders share a name; using the oldest", { name, count: folders.length });
    }
    return folders[0]?.id ?? undefined;
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const res = await this.call("files.create(folder)", () =>
      this.api.files.create(
        { requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] }, fields: "id", supportsAllDrives: true },
        this.requestOptions,
      ),
    );
    if (!res.data.id) throw new GoogleDriveError(`Creating folder "${name}" returned no ID`);
    this.logger.info("Created Google Drive folder", { name, folder_id: res.data.id });
    return res.data.id;
  }

  private async isUsableFolder(id: string): Promise<boolean> {
    try {
      const res = await this.call("files.get(folder)", () =>
        this.api.files.get({ fileId: id, fields: "id,mimeType,trashed", supportsAllDrives: true }, this.requestOptions),
      );
      return res.data.mimeType === FOLDER_MIME && !res.data.trashed;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async prepare(cache: RemoteCache, options: { dryRun: boolean }): Promise<PrepareResult> {
    const { folder_id, folder_path } = this.settings;
    this.cache = { ...cache };

    if (folder_id.trim() !== "") {
      const id = folder_id.trim();
      if (!(await this.isUsableFolder(id))) {
        throw new GoogleDriveError(`Configured Google Drive folder ${id} does not exist, is not a folder, or is not accessible`, {
          hint:
            this.settings.scope === "drive.file"
              ? 'With scope "drive.file" the app can only see folders it created. Use folder_path instead, or set google_drive.scope to "drive" and run notesync auth again.'
              : "Check google_drive.folder_id (the ID is the last part of the folder's URL).",
        });
      }
      this.folderId = id;
      if (this.cache.folderKey !== `id:${id}`) this.cache = { folderKey: `id:${id}`, folderId: id };
      return { cache: this.getCache(), folderExists: true, folderDescription: `folder ${id}` };
    }

    const segments = folder_path.split(/[\\/]/).map((s) => s.trim()).filter(Boolean);
    const key = `path:${segments.join("/")}`;
    const description = segments.length ? `My Drive/${segments.join("/")}` : "My Drive";

    if (this.cache.folderKey === key && this.cache.folderId && (await this.isUsableFolder(this.cache.folderId))) {
      this.folderId = this.cache.folderId;
      return { cache: this.getCache(), folderExists: true, folderDescription: description };
    }

    let parent = "root";
    for (const segment of segments) {
      const existing = await this.findChildFolder(parent, segment);
      if (existing) {
        parent = existing;
        continue;
      }
      if (options.dryRun) {
        this.logger.info("Dry run: would create Google Drive folder", { path: description });
        this.cache = { folderKey: key };
        return { cache: this.getCache(), folderExists: false, folderDescription: description };
      }
      parent = await this.createFolder(parent, segment);
    }
    this.folderId = parent;
    this.cache = { folderKey: key, folderId: parent };
    return { cache: this.getCache(), folderExists: true, folderDescription: description };
  }

  async listManagedFiles(): Promise<RemoteFile[]> {
    const folderId = this.requireFolder();
    const files: RemoteFile[] = [];
    let pageToken: string | undefined;
    do {
      const token = pageToken;
      const res = await this.call("files.list", () =>
        this.api.files.list(
          {
            q: `'${escapeQuery(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
            fields: `nextPageToken,files(${FILE_FIELDS})`,
            pageSize: 1000,
            pageToken: token,
            spaces: "drive",
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          },
          this.requestOptions,
        ),
      );
      for (const file of res.data.files ?? []) {
        const remote = toRemoteFile(file);
        if (remote.noteId) files.push(remote);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return files;
  }

  /** Files in the sync folder tagged with this note ID (normally zero or one). */
  private async findByNoteId(noteId: string): Promise<RemoteFile[]> {
    const folderId = this.requireFolder();
    const res = await this.call("files.list(byNote)", () =>
      this.api.files.list(
        {
          q: `appProperties has { key='${PROP_NOTE_ID}' and value='${escapeQuery(noteId)}' } and '${escapeQuery(folderId)}' in parents and trashed = false`,
          fields: `files(${FILE_FIELDS})`,
          pageSize: 10,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
        this.requestOptions,
      ),
    );
    return (res.data.files ?? []).map(toRemoteFile);
  }

  private properties(input: { noteId: string; contentHash: string; renderFingerprint: string }) {
    return { [PROP_NOTE_ID]: input.noteId, [PROP_HASH]: input.contentHash, [PROP_RENDER]: input.renderFingerprint };
  }

  async createFile(input: UploadInput): Promise<RemoteFile> {
    const folderId = this.requireFolder();
    return this.call(
      "upload",
      async (attempt) => {
        // If an earlier attempt's response was lost (e.g. connection reset after Drive
        // stored the file), retrying blindly would create a duplicate. Check first.
        if (attempt > 1) {
          const existing = await this.findByNoteId(input.noteId);
          if (existing[0]) {
            this.logger.info("Upload had already succeeded before the retry; reusing file", { drive_file_id: existing[0].id });
            return existing[0];
          }
        }
        const res = await this.api.files.create(
          {
            requestBody: {
              name: input.name,
              parents: [folderId],
              mimeType: input.mimeType,
              appProperties: this.properties(input),
            },
            media: { mimeType: input.mimeType, body: Readable.from(input.data) },
            fields: FILE_FIELDS,
            supportsAllDrives: true,
          },
          this.requestOptions,
        );
        return toRemoteFile(res.data);
      },
      "upload",
    );
  }

  async updateFile(fileId: string, input: UpdateInput): Promise<RemoteFile> {
    const folderId = this.requireFolder();
    let addParents: string | undefined;
    let removeParents: string | undefined;
    if (input.moveIntoFolder) {
      const current = await this.getFile(fileId);
      const others = (current?.parents ?? []).filter((p) => p !== folderId);
      if (current && !current.parents.includes(folderId)) addParents = folderId;
      if (others.length) removeParents = others.join(",");
    }
    return this.call(
      input.data ? "update" : "rename",
      async () => {
        const res = await this.api.files.update(
          {
            fileId,
            requestBody: {
              name: input.name,
              appProperties: this.properties(input),
              ...(input.restore ? { trashed: false } : {}),
            },
            media: input.data ? { mimeType: input.mimeType, body: Readable.from(input.data) } : undefined,
            addParents,
            removeParents,
            fields: FILE_FIELDS,
            supportsAllDrives: true,
          },
          this.requestOptions,
        );
        return toRemoteFile(res.data);
      },
      "upload",
    );
  }

  async trashFile(fileId: string): Promise<void> {
    try {
      await this.call("trash", () =>
        this.api.files.update({ fileId, requestBody: { trashed: true }, fields: "id", supportsAllDrives: true }, this.requestOptions),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.call("delete", () => this.api.files.delete({ fileId, supportsAllDrives: true }, this.requestOptions));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async archiveFolder(): Promise<string> {
    const folderId = this.requireFolder();
    if (this.cache.archiveFolderId && (await this.isUsableFolder(this.cache.archiveFolderId))) {
      return this.cache.archiveFolderId;
    }
    const name = this.settings.archive_folder_name;
    const id = (await this.findChildFolder(folderId, name)) ?? (await this.createFolder(folderId, name));
    this.cache.archiveFolderId = id;
    return id;
  }

  async archiveFile(fileId: string): Promise<void> {
    const archiveId = await this.archiveFolder();
    const current = await this.getFile(fileId);
    if (!current) return;
    const remove = current.parents.filter((p) => p !== archiveId);
    try {
      await this.call("archive", () =>
        this.api.files.update(
          {
            fileId,
            addParents: current.parents.includes(archiveId) ? undefined : archiveId,
            removeParents: remove.length ? remove.join(",") : undefined,
            fields: "id",
            supportsAllDrives: true,
          },
          this.requestOptions,
        ),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /** Lightweight connectivity/permission probe for `doctor`. */
  async probe(): Promise<string> {
    try {
      const res = await this.call("about.get", () => this.api.about.get({ fields: "user(emailAddress)" }, this.requestOptions));
      return res.data.user?.emailAddress ?? "unknown account";
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new GoogleDriveError(`Drive API unreachable: ${errorMessage(error)}`, { cause: error });
    }
  }
}
