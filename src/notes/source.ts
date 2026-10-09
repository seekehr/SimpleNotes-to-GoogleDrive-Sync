import type { AppError } from "../errors.js";
import type { Note } from "./note.js";

/** A note the source knows exists but could not load completely. It must not be treated as deleted. */
export interface NoteLoadFailure {
  id: string;
  title: string;
  error: AppError;
}

export interface FetchResult {
  notes: Note[];
  failures: NoteLoadFailure[];
  /**
   * False when the source could not list every note (e.g. output truncation).
   * The sync engine skips deletion handling for incomplete listings.
   */
  complete: boolean;
  warnings: string[];
  durationMs: number;
}

/** Where notes come from. SimpleNotesScraper is the only implementation today. */
export interface NoteSource {
  fetchNotes(): Promise<FetchResult>;
}
