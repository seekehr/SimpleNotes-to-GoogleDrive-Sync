import type { Note } from "../notes/note.js";
import type { NoteState } from "../state/types.js";
import { sha256, stableStringify } from "../util/hash.js";

/**
 * Hash of everything that influences a note's document: normalized content, tags
 * (written to document properties) and the Markdown flag. Dates and revision only
 * count when metadata is printed in the document — otherwise e.g. pinning a note,
 * which bumps its revision, would trigger a pointless re-upload.
 */
export function contentHash(note: Note, includeMetadata: boolean): string {
  return sha256(
    stableStringify({
      content: note.content.normalize("NFC"),
      tags: [...note.tags].sort(),
      markdown: note.isMarkdown,
      meta: includeMetadata
        ? {
            id: note.id,
            createdAt: note.createdAt?.toISOString(),
            updatedAt: note.updatedAt?.toISOString(),
            revision: note.revision,
          }
        : null,
    }),
  );
}

export type ChangeReason =
  | "new"
  | "content"
  | "style"
  | "rename"
  | "remote-missing"
  | "remote-stale"
  | "recovered"
  | "forced";

export interface ChangeAssessment {
  changed: boolean;
  /** True when the document body must be regenerated and uploaded (vs. rename only). */
  needsContent: boolean;
  reasons: ChangeReason[];
}

/** Compares a note with its last synced state. Remote checks are applied by the planner. */
export function assessChange(
  previous: NoteState | undefined,
  hash: string,
  renderFingerprint: string,
  filename: string,
  force: boolean,
): ChangeAssessment {
  if (!previous || !previous.remoteFileId) {
    return { changed: true, needsContent: true, reasons: ["new"] };
  }
  const reasons: ChangeReason[] = [];
  if (previous.contentHash !== hash) reasons.push("content");
  if (previous.renderFingerprint !== renderFingerprint) reasons.push("style");
  if (previous.filename !== filename) reasons.push("rename");
  if (force) reasons.push("forced");
  const needsContent = reasons.some((r) => r !== "rename");
  return { changed: reasons.length > 0, needsContent, reasons };
}
