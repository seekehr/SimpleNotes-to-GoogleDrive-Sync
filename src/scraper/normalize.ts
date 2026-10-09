import { ScraperOutputError } from "../errors.js";
import { type Note, normalizeLineEndings } from "../notes/note.js";
import { deriveTitle } from "../notes/title.js";
import { TruncatedString } from "./inspectParser.js";

/**
 * One entry of SimpleNotesScraper's `NOTES:` listing, as observed in its stdout:
 *   { id, version, title, content, tags, systemTags, creationDate, modificationDate }
 * This type stays inside src/scraper — the rest of the app only sees `Note`.
 */
export interface ScrapedRecord {
  id: string;
  version?: string;
  /** The scraper's own title (raw first line); used to locate its output file. */
  scraperTitle: string | TruncatedString;
  content: string | TruncatedString;
  tags: string[];
  systemTags: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "string" && value !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Simperium uses epoch seconds.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  return undefined;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Validates one raw listing entry. Throws ScraperOutputError when it lacks an id. */
export function toScrapedRecord(raw: unknown, index: number): ScrapedRecord {
  if (!isRecord(raw)) throw new ScraperOutputError(`Listing entry #${index + 1} is not an object`);
  const id = raw.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new ScraperOutputError(`Listing entry #${index + 1} has no note id`);
  }
  const content = raw.content;
  const title = raw.title;
  return {
    id,
    version: raw.version === undefined || raw.version === null ? undefined : String(raw.version),
    scraperTitle: typeof title === "string" || title instanceof TruncatedString ? title : "Untitled",
    content: typeof content === "string" || content instanceof TruncatedString ? content : "",
    tags: toStringList(raw.tags),
    systemTags: toStringList(raw.systemTags),
    createdAt: toDate(raw.creationDate),
    updatedAt: toDate(raw.modificationDate),
  };
}

export function toNote(record: ScrapedRecord, fullContent: string): Note {
  const content = normalizeLineEndings(fullContent);
  return {
    id: record.id,
    title: deriveTitle(content),
    content,
    tags: record.tags,
    systemTags: record.systemTags,
    isMarkdown: record.systemTags.includes("markdown"),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.version,
  };
}

/**
 * Re-implementation of SimpleNotesScraper's own filename function, used only to find
 * the .txt file it wrote for a note. Must stay byte-for-byte identical to the scraper.
 */
export function scraperFileName(title: string): string {
  const sanitized = title
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 200);
  if (!sanitized) return "Untitled";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized) ? `_${sanitized}` : sanitized;
}
