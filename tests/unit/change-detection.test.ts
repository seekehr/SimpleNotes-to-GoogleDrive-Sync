import { describe, expect, it } from "vitest";
import type { NoteState } from "../../src/state/types.js";
import { assessChange, contentHash } from "../../src/sync/changeDetector.js";
import { note } from "../helpers/harness.js";

const previous = (extra: Partial<NoteState> = {}): NoteState => ({
  title: "T",
  filename: "T.docx",
  contentHash: "hash",
  renderFingerprint: "fp",
  tags: [],
  remoteFileId: "file-1",
  lastSynced: "2026-01-01T00:00:00Z",
  status: "synced",
  ...extra,
});

describe("contentHash", () => {
  it("is a stable SHA-256 hex digest", () => {
    const h = contentHash(note("a", "hello"), false);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(note("a", "hello"), false)).toBe(h);
  });

  it("changes when content or tags change", () => {
    const base = contentHash(note("a", "hello"), false);
    expect(contentHash(note("a", "hello!"), false)).not.toBe(base);
    expect(contentHash(note("a", "hello", { tags: ["x"] }), false)).not.toBe(base);
  });

  it("ignores tag order and Unicode normalization form", () => {
    expect(contentHash(note("a", "x", { tags: ["a", "b"] }), false)).toBe(contentHash(note("a", "x", { tags: ["b", "a"] }), false));
    expect(contentHash(note("a", "café"), false)).toBe(contentHash(note("a", "café"), false));
  });

  it("ignores revision and dates unless metadata is printed in the document", () => {
    const a = note("a", "x", { revision: "1" });
    const b = note("a", "x", { revision: "2", updatedAt: new Date("2030-01-01") });
    expect(contentHash(a, false)).toBe(contentHash(b, false));
    expect(contentHash(a, true)).not.toBe(contentHash(b, true));
  });
});

describe("assessChange", () => {
  it("reports new notes", () => {
    expect(assessChange(undefined, "hash", "fp", "T.docx", false)).toEqual({ changed: true, needsContent: true, reasons: ["new"] });
    expect(assessChange(previous({ remoteFileId: undefined }), "hash", "fp", "T.docx", false).reasons).toEqual(["new"]);
  });

  it("reports unchanged notes", () => {
    expect(assessChange(previous(), "hash", "fp", "T.docx", false)).toEqual({ changed: false, needsContent: false, reasons: [] });
  });

  it("detects content, style and forced changes as needing new content", () => {
    expect(assessChange(previous(), "other", "fp", "T.docx", false)).toMatchObject({ needsContent: true, reasons: ["content"] });
    expect(assessChange(previous(), "hash", "fp2", "T.docx", false)).toMatchObject({ needsContent: true, reasons: ["style"] });
    expect(assessChange(previous(), "hash", "fp", "T.docx", true)).toMatchObject({ needsContent: true, reasons: ["forced"] });
  });

  it("treats a filename-only change as a rename without re-upload", () => {
    expect(assessChange(previous(), "hash", "fp", "U.docx", false)).toEqual({ changed: true, needsContent: false, reasons: ["rename"] });
  });
});
