import type { Note } from "../notes/note.js";
import type { NoteState } from "../state/types.js";

export const MAX_BASENAME_LENGTH = 150;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Turns a note title into a filename base that is valid on Windows and unambiguous
 * in Google Drive:
 *   "Project: Backend / API?"  ->  "Project - Backend - API"
 *   "20/10/2023"               ->  "20-10-2023"
 * Separators (: / \ |) become " - ", characters that are merely illegal (? * < > and
 * control characters) are dropped, double quotes become single quotes, and
 * Windows-reserved names / trailing dots and spaces are handled.
 */
export function sanitizeFilename(title: string): string {
  let name = title
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/"/g, "'")
    .replace(/[?*<>]/g, "")
    // Dates such as 20/10/2023 read better as 20-10-2023 than "20 - 10 - 2023".
    .replace(/(\d)[/\\](?=\d)/g, "$1-")
    .replace(/\s*[:/\\|]+\s*/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/( - )+/g, " - ")
    .replace(/^[\s.\-]+|[\s.\-]+$/g, "");

  if (name.length > MAX_BASENAME_LENGTH) {
    name = name.slice(0, MAX_BASENAME_LENGTH).replace(/[\s.\-]+$/g, "");
    // Do not leave half of a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  }
  if (name === "") name = "Untitled";
  if (WINDOWS_RESERVED.test(name)) name = `${name}_`;
  return name;
}

const key = (filename: string): string => filename.normalize("NFC").toLowerCase();

/** Whether `filename` is `base + ext` or a numbered variant `base (n) + ext`. */
export function filenameMatchesBase(filename: string, base: string, extension: string): boolean {
  if (!filename.toLowerCase().endsWith(extension.toLowerCase())) return false;
  const stem = filename.slice(0, -extension.length);
  if (key(stem) === key(base)) return true;
  const match = /^(.*) \((\d+)\)$/.exec(stem);
  return match !== null && key(match[1] as string) === key(base) && Number(match[2]) >= 2;
}

/**
 * Assigns each note a unique filename, keeping existing assignments stable.
 *
 * Phase 1: a note whose title still maps to the same base keeps its previous
 *          filename, so "Meeting Notes (2).docx" stays (2) even if the original
 *          "Meeting Notes" note is deleted or the scraper lists notes in a new order.
 * Phase 2: new and renamed notes get the first free name, in a deterministic order
 *          (creation date, then ID).
 *
 * Filenames of tracked-but-absent notes (load failures, deleted notes whose Drive
 * file is kept) are reserved so a new note never takes their name.
 */
export function allocateFilenames(
  notes: readonly Note[],
  state: Readonly<Record<string, NoteState>>,
  extension: string,
  reservedIds: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  const present = new Set(notes.map((n) => n.id));

  for (const [id, entry] of Object.entries(state)) {
    if (present.has(id)) continue;
    const keptRemotely = entry.status === "deleted" && entry.deletionAction === "keep";
    if (reservedIds.has(id) || keptRemotely || entry.status === "synced") taken.add(key(entry.filename));
  }

  const pending: Note[] = [];
  for (const note of notes) {
    const previous = state[note.id];
    const base = sanitizeFilename(note.title);
    if (previous && filenameMatchesBase(previous.filename, base, extension) && !taken.has(key(previous.filename))) {
      result.set(note.id, previous.filename);
      taken.add(key(previous.filename));
    } else {
      pending.push(note);
    }
  }

  pending.sort((a, b) => {
    const ta = a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const tb = b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  for (const note of pending) {
    const base = sanitizeFilename(note.title);
    let candidate = `${base}${extension}`;
    for (let n = 2; taken.has(key(candidate)); n++) candidate = `${base} (${n})${extension}`;
    result.set(note.id, candidate);
    taken.add(key(candidate));
  }
  return result;
}
