import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { classifyDriveError } from "../../src/drive/errors.js";
import { GoogleDriveStore, PROP_NOTE_ID, escapeQuery } from "../../src/drive/googleDriveStore.js";
import {
  GoogleDriveAuthenticationError,
  GoogleDriveError,
  GoogleDriveUploadError,
  NetworkError,
  RateLimitError,
} from "../../src/errors.js";
import { MemorySink, createLogger } from "../../src/logging/logger.js";
import { FakeDrive } from "../helpers/fakeDrive.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function makeStore(settings: Partial<ReturnType<typeof configSchema.parse>["google_drive"]> = {}, drive = new FakeDrive()) {
  const sink = new MemorySink();
  const store = new GoogleDriveStore({
    settings: { ...configSchema.parse({}).google_drive, ...settings },
    retry: { attempts: 4, initialDelayMs: 1, maxDelayMs: 2 },
    logger: createLogger({ level: "debug", console: false, extraSinks: [sink] }),
    api: drive.api(),
  });
  return { store, drive, sink };
}

const upload = (noteId: string, name = `${noteId}.docx`) => ({
  noteId,
  name,
  data: Buffer.from(`content of ${noteId}`),
  mimeType: DOCX,
  contentHash: "hash",
  renderFingerprint: "fp",
});

describe("classifyDriveError", () => {
  const err = (status?: number, reason?: string, code?: string) =>
    Object.assign(new Error("x"), {
      code,
      response: status ? { status, headers: { "retry-after": "7" }, data: reason === "invalid_grant" ? { error: reason } : { error: { errors: [{ reason }] } } } : undefined,
    });

  it.each([429, 500, 502, 503, 504])("treats HTTP %i as retryable", (status) => {
    expect(classifyDriveError(err(status), "op").retryable).toBe(true);
  });

  it("maps 429 and rate-limit 403s to RateLimitError with Retry-After", () => {
    const e = classifyDriveError(err(429), "op");
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).retryAfterMs).toBe(7000);
    expect(classifyDriveError(err(403, "userRateLimitExceeded"), "op")).toBeInstanceOf(RateLimitError);
  });

  it("does not retry permission, validation or auth failures", () => {
    expect(classifyDriveError(err(403, "insufficientPermissions"), "op").retryable).toBe(false);
    expect(classifyDriveError(err(400, "badRequest"), "op").retryable).toBe(false);
    expect(classifyDriveError(err(401), "op")).toBeInstanceOf(GoogleDriveAuthenticationError);
    const grant = classifyDriveError(err(400, "invalid_grant"), "op");
    expect(grant).toBeInstanceOf(GoogleDriveAuthenticationError);
    expect(grant.retryable).toBe(false);
    expect(grant.hint).toMatch(/notesync auth/);
  });

  it("treats connection resets and timeouts as retryable network errors", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
      const e = classifyDriveError(err(undefined, undefined, code), "op");
      expect(e).toBeInstanceOf(NetworkError);
      expect(e.retryable).toBe(true);
    }
    expect(classifyDriveError(Object.assign(new Error("aborted"), { name: "AbortError" }), "op")).toBeInstanceOf(NetworkError);
  });

  it("uses GoogleDriveUploadError for upload operations", () => {
    expect(classifyDriveError(err(500), "upload", "upload")).toBeInstanceOf(GoogleDriveUploadError);
    expect(classifyDriveError(err(404), "files.get")).toBeInstanceOf(GoogleDriveError);
  });
});

describe("GoogleDriveStore", () => {
  it("escapes Drive query literals", () => {
    expect(escapeQuery("it's a \\ test")).toBe("it\\'s a \\\\ test");
  });

  it("creates the folder path once and reuses the cached ID", async () => {
    const { store, drive } = makeStore({ folder_path: "Backups/Simplenote" });
    const first = await store.prepare({}, { dryRun: false });
    expect(first.folderExists).toBe(true);
    expect(first.cache.folderKey).toBe("path:Backups/Simplenote");
    const created = drive.count("create");
    const second = await store.prepare(first.cache, { dryRun: false });
    expect(second.cache.folderId).toBe(first.cache.folderId);
    expect(drive.count("create")).toBe(created);
    expect(drive.folderByName("Simplenote")?.parents).toEqual([drive.folderByName("Backups")?.id]);
  });

  it("does not create folders in dry-run", async () => {
    const { store, drive } = makeStore();
    const result = await store.prepare({}, { dryRun: true });
    expect(result.folderExists).toBe(false);
    expect(drive.count("create")).toBe(0);
  });

  it("validates a configured folder_id", async () => {
    const { store } = makeStore({ folder_id: "missing" });
    await expect(store.prepare({}, { dryRun: false })).rejects.toThrow(/does not exist/);
    const drive = new FakeDrive();
    const id = drive.addFolder("Mine");
    const ok = makeStore({ folder_id: id }, drive);
    expect((await ok.store.prepare({}, { dryRun: false })).cache.folderId).toBe(id);
  });

  it("tags uploads with the note ID and lists only tagged files", async () => {
    const { store, drive } = makeStore();
    await store.prepare({}, { dryRun: false });
    const file = await store.createFile(upload("n1"));
    const folder = drive.folderByName("Simplenote")!.id;
    drive.addFile({ name: "user file.docx", parents: [folder] });
    expect(drive.files.get(file.id)!.appProperties[PROP_NOTE_ID]).toBe("n1");
    expect(drive.files.get(file.id)!.content!.toString()).toBe("content of n1");
    const listed = await store.listManagedFiles();
    expect(listed.map((f) => f.noteId)).toEqual(["n1"]);
  });

  it("pages through large folders", async () => {
    const { store, drive } = makeStore();
    await store.prepare({}, { dryRun: false });
    const folder = drive.folderByName("Simplenote")!.id;
    for (let i = 0; i < 1203; i++) drive.addFile({ name: `${i}.docx`, parents: [folder], appProperties: { [PROP_NOTE_ID]: `n${i}` } });
    expect(await store.listManagedFiles()).toHaveLength(1203);
  });

  it("retries rate limits and server errors, then succeeds", async () => {
    const { store, drive, sink } = makeStore();
    await store.prepare({}, { dryRun: false });
    drive.failNext("create", { status: 429 }, { status: 503 });
    const file = await store.createFile(upload("n1"));
    expect(file.id).toBeTruthy();
    expect(drive.filesIn(drive.folderByName("Simplenote")!.id)).toHaveLength(1);
    expect(sink.lines.filter((l) => l.includes("Retrying Google Drive request"))).toHaveLength(2);
  });

  it("does not create a duplicate when the create response is lost", async () => {
    const { store, drive } = makeStore();
    await store.prepare({}, { dryRun: false });
    drive.loseNextCreateResponse = true;
    const file = await store.createFile(upload("n1"));
    const files = drive.filesIn(drive.folderByName("Simplenote")!.id);
    expect(files).toHaveLength(1);
    expect(file.id).toBe(files[0]!.id);
  });

  it("does not retry authentication failures", async () => {
    const { store, drive } = makeStore();
    await store.prepare({}, { dryRun: false });
    const before = drive.count("create"); // prepare() created the folder
    drive.failNext("create", { status: 400, reason: "invalid_grant" });
    await expect(store.createFile(upload("n1"))).rejects.toBeInstanceOf(GoogleDriveAuthenticationError);
    expect(drive.count("create") - before).toBe(1);
  });

  it("gives up after the configured attempts on persistent failures", async () => {
    const { store, drive } = makeStore();
    await store.prepare({}, { dryRun: false });
    drive.failNext("update", { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    const file = await store.createFile(upload("n1"));
    await expect(store.updateFile(file.id, { ...upload("n1"), data: Buffer.from("x") })).rejects.toBeInstanceOf(GoogleDriveUploadError);
    expect(drive.count("update")).toBe(4);
  });

  it("updates content in place and can restore from trash", async () => {
    const { store, drive } = makeStore();
    await store.prepare({}, { dryRun: false });
    const file = await store.createFile(upload("n1"));
    drive.files.get(file.id)!.trashed = true;
    await store.updateFile(file.id, { ...upload("n1", "Renamed.docx"), data: Buffer.from("v2"), restore: true });
    const stored = drive.files.get(file.id)!;
    expect(stored).toMatchObject({ name: "Renamed.docx", trashed: false });
    expect(stored.content!.toString()).toBe("v2");
  });

  it("trashes, archives and deletes files, tolerating already-missing ones", async () => {
    const { store, drive } = makeStore();
    await store.prepare({}, { dryRun: false });
    const a = await store.createFile(upload("a"));
    const b = await store.createFile(upload("b"));
    const c = await store.createFile(upload("c"));
    await store.trashFile(a.id);
    await store.archiveFile(b.id);
    await store.deleteFile(c.id);
    await store.deleteFile("never-existed");
    await store.trashFile("never-existed");
    expect(drive.files.get(a.id)!.trashed).toBe(true);
    const archive = drive.folderByName("Archive")!;
    expect(drive.files.get(b.id)!.parents).toEqual([archive.id]);
    expect(archive.parents).toEqual([drive.folderByName("Simplenote")!.id]);
    expect(drive.files.has(c.id)).toBe(false);
    expect(store.getCache().archiveFolderId).toBe(archive.id);
  });
});
