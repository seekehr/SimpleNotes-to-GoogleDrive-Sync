import { z } from "zod";
import { parseDuration } from "../util/duration.js";

/**
 * Configuration schema. Keys are snake_case to match the YAML file 1:1, which keeps
 * error messages ("sync.deleted_notes: ...") pointing at exactly what the user typed.
 * Objects are strict so typos are reported instead of silently ignored.
 */

const hexColor = z
  .string()
  .regex(/^[0-9A-Fa-f]{6}$/, "expected a 6-digit hex colour such as 1F1F1F (no leading #)");

const positive = z.number().positive();
const nonNegative = z.number().min(0);

const durationString = z.string().refine((v) => v.trim() === "" || parseDuration(v) !== undefined, {
  message: 'expected a duration such as "30s", "5m", "15m" or "1h"',
});

export const DELETION_POLICIES = ["keep", "delete", "move_to_trash", "archive"] as const;
export type DeletionPolicy = (typeof DELETION_POLICIES)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const simplenoteSchema = z.strictObject({
  /** Executable name (resolved on PATH) or absolute path. */
  scraper_command: z.string().min(1).default("simplenotesscraper"),
  /** Extra arguments appended after `--env-dir <env_dir>`. */
  scraper_args: z.array(z.string()).default([]),
  /** Directory containing the scraper's .env (TOKEN / GMAIL). */
  env_dir: z.string().min(1).default("C:\\Users\\Hp\\Documents\\SimpleNotesScraper"),
  timeout_seconds: positive.default(120),
  /**
   * Working directory the scraper runs in. SimpleNotesScraper writes (and first
   * deletes!) `<cwd>/output`, so this must be a directory owned by this app.
   */
  work_dir: z.string().min(1).default("./data/scraper"),
  /** Where the scraper's .txt files appear. Empty = `<work_dir>/output`. */
  output_dir: z.string().default(""),
});

const headingSchema = z.strictObject({
  font: z.string().default(""),
  color: hexColor.default("1F1F1F"),
  bold: z.boolean().default(true),
  /** Point sizes for heading levels 1-6. */
  sizes: z.array(positive).length(6).default([20, 16, 14, 12, 11, 11]),
  spacing_before: nonNegative.default(14),
  spacing_after: nonNegative.default(4),
});

const listSchema = z.strictObject({
  /** Indentation added per nesting level, in points. */
  indent_pt: positive.default(18),
  /** Hanging indent for the bullet/number, in points. */
  hanging_pt: positive.default(14),
  spacing_after: nonNegative.default(2),
});

const codeSchema = z.strictObject({
  background: hexColor.default("F5F5F5"),
  border_color: hexColor.default("DDDDDD"),
  inline_background: hexColor.default("F2F2F2"),
});

const tableSchema = z.strictObject({
  border_color: hexColor.default("BFBFBF"),
  header_background: hexColor.default("F2F2F2"),
  header_bold: z.boolean().default(true),
  cell_padding_pt: nonNegative.default(4),
});

const blockquoteSchema = z.strictObject({
  border_color: hexColor.default("C8C8C8"),
  text_color: hexColor.default("555555"),
  indent_pt: nonNegative.default(12),
});

const pageSchema = z.strictObject({
  size: z.enum(["letter", "a4"]).default("letter"),
  margins_inches: z
    .strictObject({
      top: nonNegative.default(1),
      right: nonNegative.default(1),
      bottom: nonNegative.default(1),
      left: nonNegative.default(1),
    })
    .prefault({}),
});

const documentSchema = z.strictObject({
  /** Append a small metadata table (ID, dates, tags, revision) to each document. */
  include_metadata: z.boolean().default(false),
  /**
   * auto   - treat a note as Markdown when Simplenote marks it so (systemTag "markdown")
   * always - always parse as Markdown
   * never  - render as plain text, preserving lines
   */
  markdown_mode: z.enum(["auto", "always", "never"]).default("auto"),
  /** Simplenote renders single newlines as line breaks; mirror that by default. */
  hard_line_breaks: z.boolean().default(true),
  font: z.string().min(1).default("Aptos"),
  font_size: positive.default(11),
  text_color: hexColor.default("000000"),
  code_font: z.string().min(1).default("Consolas"),
  code_font_size: positive.default(10),
  line_spacing: positive.default(1.15),
  paragraph_spacing_before: nonNegative.default(0),
  paragraph_spacing_after: nonNegative.default(8),
  link_color: hexColor.default("0563C1"),
  headings: headingSchema.prefault({}),
  lists: listSchema.prefault({}),
  code: codeSchema.prefault({}),
  table: tableSchema.prefault({}),
  blockquote: blockquoteSchema.prefault({}),
  page: pageSchema.prefault({}),
});

const syncSchema = z.strictObject({
  interval_minutes: positive.default(10),
  /** Alternative to interval_minutes accepting "30s", "5m", "1h". Takes precedence when set. */
  interval: durationString.default(""),
  run_on_startup: z.boolean().default(true),
  deleted_notes: z.enum(DELETION_POLICIES).default("keep"),
  /** Re-upload every note even when unchanged (same as `sync --force`). */
  upload_unchanged: z.boolean().default(false),
  max_concurrent_uploads: z.number().int().min(1).max(10).default(3),
  /**
   * Safety valve: if more than this fraction of tracked notes disappear in one run
   * (e.g. the scraper returned a partial list), deletions are skipped for that run.
   * `--force` overrides. Set to 1 to disable.
   */
  max_deletion_ratio: z.number().min(0).max(1).default(0.5),
  /** What to do with extra Drive copies of the same note: warn, or move extras to trash. */
  duplicates: z.enum(["warn", "trash"]).default("warn"),
  /** Re-upload a note whose Drive file was deleted/trashed by someone else. */
  restore_missing_remote: z.boolean().default(true),
});

const outputSchema = z.strictObject({
  temp_directory: z.string().min(1).default("./data/temp"),
  generated_directory: z.string().min(1).default("./data/generated"),
  keep_local_docx: z.boolean().default(true),
});

const stateSchema = z.strictObject({
  file: z.string().min(1).default("./data/state.json"),
  lock_file: z.string().min(1).default("./data/sync.lock"),
});

const driveSchema = z.strictObject({
  /** Destination folder ID. Takes precedence over folder_path. */
  folder_id: z.string().default(""),
  /** Folder path from My Drive root, e.g. "Backups/Simplenote". Created if missing; ID is cached in state. */
  folder_path: z.string().default("Simplenote"),
  /** Sub-folder (inside the destination) used by the `archive` deletion policy. */
  archive_folder_name: z.string().min(1).default("Archive"),
  credentials_file: z.string().min(1).default("./config/google_credentials.json"),
  /**
   * drive.file - least privilege; the app sees only files/folders it created (recommended).
   * drive      - full Drive access; needed when folder_id points at a folder you created by hand.
   */
  scope: z.enum(["drive.file", "drive"]).default("drive.file"),
  /** auto = Windows Credential Manager / OS keychain, falling back to token_file. */
  token_store: z.enum(["auto", "keyring", "file"]).default("auto"),
  token_file: z.string().min(1).default("./data/google_token.json"),
  request_timeout_seconds: positive.default(120),
});

const loggingSchema = z.strictObject({
  level: z.enum(LOG_LEVELS).default("info"),
  /** Empty string disables file logging. */
  file: z.string().default("./logs/sync.log"),
  console: z.boolean().default(true),
  max_size_mb: positive.default(5),
  max_files: z.number().int().min(1).max(50).default(5),
});

const retrySchema = z.strictObject({
  attempts: z.number().int().min(1).max(20).default(5),
  initial_delay_seconds: positive.default(2),
  max_delay_seconds: positive.default(60),
});

export const configSchema = z.strictObject({
  simplenote: simplenoteSchema.prefault({}),
  sync: syncSchema.prefault({}),
  output: outputSchema.prefault({}),
  state: stateSchema.prefault({}),
  google_drive: driveSchema.prefault({}),
  document: documentSchema.prefault({}),
  logging: loggingSchema.prefault({}),
  retry: retrySchema.prefault({}),
});

export type AppConfig = z.infer<typeof configSchema>;
export type DocumentConfig = AppConfig["document"];
export type RetryConfig = AppConfig["retry"];
