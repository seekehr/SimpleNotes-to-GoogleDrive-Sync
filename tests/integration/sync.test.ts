import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleDriveAuthenticationError, LockError, ScraperExecutionError } from "../../src/errors.js";
import { PROP_NOTE_ID } from "../../src/drive/googleDriveStore.js";
import { acquireLock } from "../../src/state/lock.js";
import { parseDocx } from "../helpers/docx.js";
import { type Harness, createHarness, note } from "../helpers/harness.js";

let h: Harness;
afterEach(() => h?.cleanup());

const readState = () => JSON.parse(readFileSync(h.config.state.file, "utf8"));
const driveFiles = () => h.drive.filesIn(h.folderId());

describe("full synchronization flow", () => {
  it("uploads new notes as formatted DOCX files and records state", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "# Project Notes\n\nThis is **important**."), note("n2", "Shopping\n\n- milk")];
    const report = await h.sync();

    expect(report.counts).toMatchObject({ discovered: 2, new: 2, updated: 0, unchanged: 0, failed: 0 });
    const files = driveFiles();
    expect(files.map((f) => f.name).sort()).toEqual(["Project Notes.docx", "Shopping.docx"]);
    const doc = await parseDocx(files.find((f) => f.name === "Project Notes.docx")!.content!);
    expect(doc.paragraphs[0]).toMatchObject({ text: "Project Notes", style: "Heading1" });
    expect(doc.paragraphs[1]!.runs.find((r) => r.text === "important")?.bold).toBe(true);

    const state = readState();
    expect(state.notes.n1).toMatchObject({ filename: "Project Notes.docx", status: "synced" });
    expect(state.notes.n1.remoteFileId).toBe(files.find((f) => f.name === "Project Notes.docx")!.id);
    expect(state.notes.n1.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.lastRun.outcome).toBe("success");
    expect(readdirSync(h.config.output.generated_directory).sort()).toEqual(["Project Notes.docx", "Shopping.docx"]);
    expect(readdirSync(h.config.output.temp_directory)).toEqual([]);
  });

  it("does nothing on a second run when nothing changed", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "Alpha"), note("n2", "Beta")];
    await h.sync();
    const writes = h.drive.count("create") + h.drive.count("update");
    const report = await h.sync();
    expect(report.counts).toMatchObject({ new: 0, updated: 0, unchanged: 2 });
    expect(h.drive.count("create") + h.drive.count("update")).toBe(writes);
  });

  it("updates a changed note in place instead of uploading a copy", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "Project Notes\n\nv1")];
    await h.sync();
    const [original] = driveFiles();
    h.source.notes = [note("n1", "Project Notes\n\nv2")];
    const report = await h.sync();
    expect(report.counts).toMatchObject({ updated: 1, new: 0 });
    const files = driveFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe(original!.id);
    expect((await parseDocx(files[0]!.content!)).documentXml).toContain("v2");
  });

  it("renames the Drive file (and local copy) when a note's title changes", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "Old Title\n\nbody")];
    await h.sync();
    h.source.notes = [note("n1", "New Title\n\nbody")];
    const report = await h.sync();
    expect(report.counts.updated).toBe(1);
    expect(driveFiles().map((f) => f.name)).toEqual(["New Title.docx"]);
    expect(readdirSync(h.config.output.generated_directory)).toEqual(["New Title.docx"]);
    expect(report.notes[0]).toMatchObject({ previousFilename: "Old Title.docx", filename: "New Title.docx" });
  });

  it("re-uploads everything with --force and when styling changes", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "A"), note("n2", "B")];
    await h.sync();
    expect((await h.sync({ force: true })).counts.updated).toBe(2);
    h.rebuild({ document: { font_size: 13 } });
    const report = await h.sync();
    expect(report.counts.updated).toBe(2);
    expect(report.notes.every((n) => n.reasons.includes("style"))).toBe(true);
    expect((await h.sync()).counts.unchanged).toBe(2);
  });

  it("handles duplicate titles with stable numbered names", async () => {
    h = createHarness();
    const first = note("a", "Meeting Notes\n\nfirst", { createdAt: new Date("2026-01-01") });
    const second = note("b", "Meeting Notes\n\nsecond", { createdAt: new Date("2026-02-01") });
    h.source.notes = [first, second];
    await h.sync();
    expect(driveFiles().map((f) => f.name).sort()).toEqual(["Meeting Notes (2).docx", "Meeting Notes.docx"]);
    h.source.notes = [second, first]; // reordered listing
    const report = await h.sync();
    expect(report.counts.unchanged).toBe(2);
    expect(readState().notes.b.filename).toBe("Meeting Notes (2).docx");
  });

  it("isolates failures: one broken note does not stop the others and is not marked synced", async () => {
    h = createHarness();
    h.source.notes = [note("good", "Good note"), note("bad", "Bad note"), note("also-good", "Also good")];
    h.source.failures = [];
    // Make the upload of exactly one note fail permanently.
    h.drive.failWhen = (method, params) =>
      method === "create" && (params.requestBody as { name?: string } | undefined)?.name === "Bad note.docx"
        ? { status: 400, reason: "badRequest" }
        : undefined;

    const report = await h.sync();
    expect(report.counts).toMatchObject({ new: 2, failed: 1 });
    const failed = report.notes.find((n) => n.status === "failed")!;
    expect(failed).toMatchObject({ title: "Bad note" });
    expect(failed.error?.message).toMatch(/HTTP 400/);
    const state = readState();
    expect(state.notes.bad).toBeUndefined();
    expect(state.notes.good.status).toBe("synced");
    expect(state.lastRun.outcome).toBe("partial");
    expect(state.lastRun.failures[0].title).toBe("Bad note");
  });

  it("reports notes the scraper could not read without deleting them", async () => {
    h = createHarness({ sync: { deleted_notes: "move_to_trash" } });
    h.source.notes = [note("n1", "One"), note("n2", "Two")];
    await h.sync();
    h.source.notes = [note("n1", "One")];
    h.source.failures = [{ id: "n2", title: "Two", error: new ScraperExecutionError("unreadable") }];
    const report = await h.sync();
    expect(report.counts.failed).toBe(1);
    expect(report.deletions).toEqual([]);
    expect(driveFiles().every((f) => !f.trashed)).toBe(true);
  });

  it("retries temporary Drive failures transparently", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "One")];
    await h.sync(); // creates folder
    h.source.notes = [note("n1", "One\n\nchanged")];
    h.drive.failNext("update", { status: 503 }, { code: "ECONNRESET" }, { status: 429, retryAfter: "0" });
    const report = await h.sync();
    expect(report.counts).toMatchObject({ updated: 1, failed: 0 });
  });

  it("stops the run on authentication failure and leaves state untouched for unsynced notes", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "One"), note("n2", "Two"), note("n3", "Three")];
    await h.sync();
    h.source.notes = [note("n1", "One!"), note("n2", "Two!"), note("n3", "Three!")];
    h.drive.failNext("update", { status: 400, reason: "invalid_grant" });
    h.rebuild({ sync: { max_concurrent_uploads: 1 } });
    await expect(h.sync()).rejects.toBeInstanceOf(GoogleDriveAuthenticationError);
    const state = readState();
    expect(state.lastRun.outcome).toBe("failed");
    // At most the first note could have been updated before the failure.
    const fresh = await h.sync();
    expect(fresh.counts.updated + fresh.counts.unchanged).toBe(3);
  });

  it("dry-run changes nothing locally or remotely", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "One")];
    const report = await h.sync({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.notes[0]).toMatchObject({ action: "create", status: "planned" });
    expect(h.drive.count("create") + h.drive.count("update") + h.drive.count("delete")).toBe(0);
    expect(existsSync(h.config.state.file)).toBe(false);
    expect(existsSync(h.config.output.generated_directory)).toBe(false);
  });

  it("refuses to run while another sync holds the lock", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "One")];
    const lock = await acquireLock(h.config.state.lock_file);
    // Simulate a different live process by rewriting the PID to our parent.
    const info = JSON.parse(readFileSync(h.config.state.lock_file, "utf8"));
    writeFileSync(h.config.state.lock_file, JSON.stringify({ ...info, pid: process.ppid }));
    await expect(h.sync()).rejects.toBeInstanceOf(LockError);
    await lock.release();
  });

  it("fails cleanly when the scraper fails, recording the error", async () => {
    h = createHarness();
    h.source.fail = new ScraperExecutionError("boom");
    await expect(h.sync()).rejects.toThrow("boom");
    expect(readState().lastRun).toMatchObject({ outcome: "failed", error: "boom" });
  });
});

describe("crash safety and duplicate prevention", () => {
  it("re-links existing Drive files after the state file is lost (no duplicates)", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "One"), note("n2", "Two")];
    await h.sync();
    writeFileSync(h.config.state.file, "{ corrupted");
    writeFileSync(`${h.config.state.file}.bak`, "{ corrupted too");
    const report = await h.sync();
    expect(driveFiles()).toHaveLength(2);
    expect(report.counts.new).toBe(0);
    expect(report.counts.unchanged).toBe(2);
    expect(Object.keys(readState().notes).sort()).toEqual(["n1", "n2"]);
  });

  it("recovers when a crash happened after upload but before the state was saved", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "One")];
    await h.sync();
    const state = readState();
    delete state.notes.n1;
    writeFileSync(h.config.state.file, JSON.stringify(state));
    h.source.notes = [note("n1", "One\n\nedited meanwhile")];
    const report = await h.sync();
    expect(driveFiles()).toHaveLength(1);
    expect(report.notes[0]).toMatchObject({ action: "update" });
    expect(report.notes[0]!.reasons).toContain("recovered");
  });

  it("detects duplicate Drive files for one note and optionally trashes extras", async () => {
    h = createHarness({ sync: { duplicates: "trash" } });
    h.source.notes = [note("n1", "One")];
    await h.sync();
    h.drive.addFile({ name: "One (copy).docx", parents: [h.folderId()], appProperties: { [PROP_NOTE_ID]: "n1" } });
    const report = await h.sync();
    expect(report.counts.duplicates).toBe(1);
    expect(report.duplicates[0]!.trashed).toBe(true);
    expect(driveFiles()).toHaveLength(1);
    expect(driveFiles()[0]!.name).toBe("One.docx");
  });

  it("re-uploads a note whose Drive file was deleted by hand", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "One")];
    await h.sync();
    h.drive.files.delete(driveFiles()[0]!.id);
    const report = await h.sync();
    expect(report.notes[0]).toMatchObject({ action: "create" });
    expect(driveFiles()).toHaveLength(1);
    expect(readState().notes.n1.remoteFileId).toBe(driveFiles()[0]!.id);
  });

  it("restores a note's Drive file from the trash instead of uploading a copy", async () => {
    h = createHarness();
    h.source.notes = [note("n1", "One")];
    await h.sync();
    const id = driveFiles()[0]!.id;
    h.drive.files.get(id)!.trashed = true;
    const report = await h.sync();
    expect(report.notes[0]).toMatchObject({ action: "update" });
    expect(h.drive.files.get(id)!.trashed).toBe(false);
    expect(h.drive.filesIn(h.folderId(), true)).toHaveLength(1);
  });

  it("cleans stale temporary files from an interrupted run", async () => {
    h = createHarness();
    const { mkdirSync, utimesSync } = await import("node:fs");
    mkdirSync(h.config.output.temp_directory, { recursive: true });
    const stale = join(h.config.output.temp_directory, "n1-abcd.docx.snsync-tmp");
    writeFileSync(stale, "partial");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    h.source.notes = [];
    await h.sync();
    expect(existsSync(stale)).toBe(false);
  });
});

describe("deleted notes", () => {
  async function syncThenDelete(policy: "keep" | "move_to_trash" | "archive" | "delete") {
    h = createHarness({ sync: { deleted_notes: policy } });
    h.source.notes = [note("n1", "Keep me"), note("n2", "Delete me"), note("n3", "Third"), note("n4", "Fourth")];
    await h.sync();
    const id = driveFiles().find((f) => f.name === "Delete me.docx")!.id;
    h.source.notes = h.source.notes.filter((n) => n.id !== "n2");
    const report = await h.sync();
    return { id, report };
  }

  it("keeps the Drive file by default", async () => {
    const { id, report } = await syncThenDelete("keep");
    expect(h.drive.files.get(id)).toMatchObject({ trashed: false });
    expect(report.counts.deleted).toBe(0);
    expect(readState().notes.n2).toMatchObject({ status: "deleted", deletionAction: "keep" });
    expect((await h.sync()).deletions).toEqual([]); // processed only once
  });

  it("moves the Drive file to trash with move_to_trash", async () => {
    const { id, report } = await syncThenDelete("move_to_trash");
    expect(h.drive.files.get(id)!.trashed).toBe(true);
    expect(report.counts.deleted).toBe(1);
    expect(existsSync(join(h.config.output.generated_directory, "Delete me.docx"))).toBe(false);
  });

  it("moves the Drive file into the Archive folder with archive", async () => {
    const { id } = await syncThenDelete("archive");
    expect(h.drive.files.get(id)!.parents).toEqual([h.drive.folderByName("Archive")!.id]);
  });

  it("deletes permanently only with delete", async () => {
    const { id } = await syncThenDelete("delete");
    expect(h.drive.files.has(id)).toBe(false);
    expect(readState().notes.n2.remoteFileId).toBeUndefined();
  });

  it("brings an archived document back when the note is restored in Simplenote", async () => {
    const { id } = await syncThenDelete("archive");
    h.source.notes.push(note("n2", "Delete me"));
    const report = await h.sync();
    expect(report.notes.find((n) => n.id === "n2")).toMatchObject({ action: "update" });
    expect(h.drive.files.get(id)!.parents).toEqual([h.folderId()]);
    expect(readState().notes.n2.status).toBe("synced");
  });

  it("holds back mass deletions unless forced", async () => {
    h = createHarness({ sync: { deleted_notes: "move_to_trash" } });
    h.source.notes = ["a", "b", "c", "d", "e"].map((id) => note(id, `Note ${id}`));
    await h.sync();
    h.source.notes = [note("a", "Note a")];
    const report = await h.sync();
    expect(report.deletionsSkipped).toBe(4);
    expect(driveFiles()).toHaveLength(5);
    expect(report.warnings.join(" ")).toMatch(/precaution/);
    const forced = await h.sync({ force: true });
    expect(forced.counts.deleted).toBe(4);
  });

  it("never deletes when the scraper listing was incomplete", async () => {
    h = createHarness({ sync: { deleted_notes: "delete" } });
    h.source.notes = [note("a", "A"), note("b", "B")];
    await h.sync();
    h.source.notes = [note("a", "A")];
    h.source.complete = false;
    const report = await h.sync({ force: true });
    expect(report.deletions).toEqual([]);
    expect(driveFiles()).toHaveLength(2);
  });

  it("lists planned deletions in dry-run without applying them", async () => {
    h = createHarness({ sync: { deleted_notes: "move_to_trash" } });
    h.source.notes = [note("a", "A"), note("b", "B"), note("c", "C")];
    await h.sync();
    h.source.notes = [note("a", "A"), note("b", "B")];
    const report = await h.sync({ dryRun: true });
    expect(report.deletions).toEqual([expect.objectContaining({ id: "c", status: "planned", policy: "move_to_trash" })]);
    expect(driveFiles().every((f) => !f.trashed)).toBe(true);
    expect(readState().notes.c.status).toBe("synced");
  });
});

describe("title keyword filter", () => {
  it("only syncs notes whose title contains a configured keyword (case-insensitive)", async () => {
    h = createHarness({ sync: { title_keywords: ["[NOTE]", "[BOOK]"] } });
    h.source.notes = [note("a", "[NOTE] Project ideas"), note("b", "[book] Dune"), note("c", "Shopping list")];
    const report = await h.sync();
    expect(report.counts).toMatchObject({ discovered: 3, filtered: 1, new: 2 });
    expect(driveFiles().map((f) => f.name).sort()).toEqual(["[NOTE] Project ideas.docx", "[book] Dune.docx"]);
    expect(readState().notes.c).toBeUndefined();
  });

  it("leaves a previously synced note alone when it stops matching, even with a deleting policy", async () => {
    h = createHarness({ sync: { deleted_notes: "move_to_trash" } });
    h.source.notes = [note("a", "[NOTE] Keep"), note("b", "Untagged")];
    await h.sync();
    h.rebuild({ sync: { title_keywords: ["[NOTE]"] } });
    const report = await h.sync();
    expect(report.counts).toMatchObject({ filtered: 1, unchanged: 1, deleted: 0 });
    expect(report.deletions).toEqual([]);
    expect(driveFiles().every((f) => !f.trashed)).toBe(true);
    expect(readState().notes.b.status).toBe("synced");
  });

  it("syncs everything when no keywords are configured", async () => {
    h = createHarness();
    h.source.notes = [note("a", "Anything"), note("b", "[NOTE] Tagged")];
    expect((await h.sync()).counts).toMatchObject({ new: 2, filtered: 0 });
  });
});
