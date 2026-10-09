import { describe, expect, it } from "vitest";
import type { NoteState } from "../../src/state/types.js";
import { allocateFilenames, filenameMatchesBase, sanitizeFilename } from "../../src/sync/filenames.js";
import { note } from "../helpers/harness.js";

const entry = (filename: string, extra: Partial<NoteState> = {}): NoteState => ({
  title: filename,
  filename,
  contentHash: "h",
  renderFingerprint: "f",
  tags: [],
  remoteFileId: "file",
  lastSynced: "2026-01-01T00:00:00Z",
  status: "synced",
  ...extra,
});

describe("sanitizeFilename", () => {
  it.each([
    ["My Project Notes", "My Project Notes"],
    ["Project: Backend / API?", "Project - Backend - API"],
    ["a\\b|c", "a - b - c"],
    ['Say "hi"', "Say 'hi'"],
    ["What? Why*", "What Why"],
    ["<tag>", "tag"],
    ["20/10/2023", "20-10-2023"],
    ["  spaced   out  ", "spaced out"],
    ["trailing dots...", "trailing dots"],
    ["...", "Untitled"],
    ["", "Untitled"],
    ["CON", "CON_"],
    ["nul.txt", "nul.txt_"],
    ["Line\tbreak\nhere", "Line break here"],
    ["Émoji ✨ notes", "Émoji ✨ notes"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("limits length without leaving a broken surrogate pair", () => {
    const long = `${"a".repeat(149)}😀😀`;
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(150);
    expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe("filenameMatchesBase", () => {
  it("recognizes the base name and numbered variants case-insensitively", () => {
    expect(filenameMatchesBase("Notes.docx", "Notes", ".docx")).toBe(true);
    expect(filenameMatchesBase("notes (3).docx", "Notes", ".docx")).toBe(true);
    expect(filenameMatchesBase("Notes (1).docx", "Notes", ".docx")).toBe(false);
    expect(filenameMatchesBase("Other.docx", "Notes", ".docx")).toBe(false);
  });
});

describe("allocateFilenames", () => {
  it("numbers duplicate titles deterministically by creation date", () => {
    const a = note("a", "Meeting Notes", { createdAt: new Date("2026-01-02") });
    const b = note("b", "Meeting Notes", { createdAt: new Date("2026-01-01") });
    const names = allocateFilenames([a, b], {}, ".docx");
    expect(names.get("b")).toBe("Meeting Notes.docx");
    expect(names.get("a")).toBe("Meeting Notes (2).docx");
  });

  it("treats titles differing only in case as duplicates (Windows is case-insensitive)", () => {
    const names = allocateFilenames([note("a", "notes"), note("b", "NOTES")], {}, ".docx");
    expect(new Set([...names.values()].map((n) => n.toLowerCase())).size).toBe(2);
  });

  it("keeps existing assignments stable when note order changes", () => {
    const a = note("a", "Meeting Notes");
    const b = note("b", "Meeting Notes");
    const state = { a: entry("Meeting Notes (2).docx"), b: entry("Meeting Notes.docx") };
    const first = allocateFilenames([a, b], state, ".docx");
    const reordered = allocateFilenames([b, a], state, ".docx");
    expect(first.get("a")).toBe("Meeting Notes (2).docx");
    expect(first.get("b")).toBe("Meeting Notes.docx");
    expect(reordered).toEqual(first);
  });

  it("does not rename the second copy when the first is deleted", () => {
    const b = note("b", "Meeting Notes");
    const names = allocateFilenames([b], { b: entry("Meeting Notes (2).docx") }, ".docx");
    expect(names.get("b")).toBe("Meeting Notes (2).docx");
  });

  it("gives a renamed note a new name and frees nothing it does not own", () => {
    const a = note("a", "New Title");
    const names = allocateFilenames([a], { a: entry("Old Title.docx") }, ".docx");
    expect(names.get("a")).toBe("New Title.docx");
  });

  it("reserves names of notes that failed to load and of kept deleted notes", () => {
    const fresh = [note("new1", "Report"), note("new2", "Summary")];
    const state = {
      failed: entry("Report.docx"),
      gone: entry("Summary.docx", { status: "deleted", deletionAction: "keep" }),
    };
    const names = allocateFilenames(fresh, state, ".docx", new Set(["failed"]));
    expect(names.get("new1")).toBe("Report (2).docx");
    expect(names.get("new2")).toBe("Summary (2).docx");
  });

  it("frees names of notes deleted with a non-keep policy", () => {
    const names = allocateFilenames([note("n", "Summary")], { gone: entry("Summary.docx", { status: "deleted", deletionAction: "move_to_trash" }) }, ".docx");
    expect(names.get("n")).toBe("Summary.docx");
  });
});
