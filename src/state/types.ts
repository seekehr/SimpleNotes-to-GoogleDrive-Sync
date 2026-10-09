import { z } from "zod";
import { DELETION_POLICIES } from "../config/schema.js";

export const STATE_VERSION = 1;

const noteStateSchema = z.looseObject({
  title: z.string(),
  /** Stable filename assigned to this note (with extension). Only changes when the title changes. */
  filename: z.string(),
  /** SHA-256 over normalized content + render-relevant metadata. */
  contentHash: z.string(),
  /** Renderer version + styling config fingerprint the document was produced with. */
  renderFingerprint: z.string(),
  revision: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /** Google Drive file ID (or another provider's file ID). */
  remoteFileId: z.string().optional(),
  lastSynced: z.string(),
  status: z.enum(["synced", "deleted"]).default("synced"),
  deletedAt: z.string().optional(),
  deletionAction: z.enum(DELETION_POLICIES).optional(),
});

const failureSchema = z.object({ id: z.string().optional(), title: z.string(), error: z.string() });

const runRecordSchema = z.looseObject({
  startedAt: z.string(),
  finishedAt: z.string(),
  outcome: z.enum(["success", "partial", "failed", "dry-run"]),
  durationMs: z.number(),
  counts: z.record(z.string(), z.number()).default({}),
  failures: z.array(failureSchema).default([]),
  error: z.string().optional(),
});

const remoteCacheSchema = z.looseObject({
  /** Identifies what folderId was resolved from ("id:<id>" or "path:<path>"). */
  folderKey: z.string().optional(),
  folderId: z.string().optional(),
  archiveFolderId: z.string().optional(),
});

export const syncStateSchema = z.looseObject({
  version: z.literal(STATE_VERSION),
  remote: remoteCacheSchema.default({}),
  notes: z.record(z.string(), noteStateSchema).default({}),
  lastRun: runRecordSchema.optional(),
  lastSuccessAt: z.string().optional(),
});

export type NoteState = z.infer<typeof noteStateSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RemoteCache = z.infer<typeof remoteCacheSchema>;
export type SyncState = z.infer<typeof syncStateSchema>;

export const emptyState = (): SyncState => ({ version: STATE_VERSION, remote: {}, notes: {} });
