import type { DeletionPolicy } from "../config/schema.js";
import type { ChangeReason } from "./changeDetector.js";

export interface SyncOptions {
  dryRun: boolean;
  /** Re-render and re-upload every note; also overrides the deletion safety valve. */
  force: boolean;
  signal?: AbortSignal;
}

export type NoteActionKind = "create" | "update" | "rename" | "unchanged";

export interface NoteOutcome {
  id: string;
  title: string;
  filename: string;
  action: NoteActionKind;
  reasons: ChangeReason[];
  status: "done" | "planned" | "failed" | "skipped";
  previousFilename?: string;
  remoteFileId?: string;
  error?: { message: string; code: string; hint?: string };
  warnings?: string[];
}

export interface DeletionOutcome {
  id: string;
  title: string;
  filename: string;
  policy: DeletionPolicy;
  status: "done" | "planned" | "failed" | "skipped";
  error?: { message: string; code: string };
}

export interface SyncCounts {
  discovered: number;
  new: number;
  updated: number;
  renamed: number;
  unchanged: number;
  deleted: number;
  failed: number;
  duplicates: number;
}

export interface SyncReport {
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  folder: string;
  counts: SyncCounts;
  notes: NoteOutcome[];
  deletions: DeletionOutcome[];
  /** Deletions held back by the safety valve or an incomplete listing. */
  deletionsSkipped: number;
  duplicates: { noteId: string; keptFileId: string; extraFileIds: string[]; trashed: boolean }[];
  warnings: string[];
  aborted: boolean;
}
