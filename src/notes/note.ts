/**
 * The application's normalized note. Scraper-specific shapes are converted into
 * this at the boundary (src/scraper/normalize.ts) and never leak further.
 */
export interface Note {
  /** Stable Simplenote note key. */
  id: string;
  /** Plain-text title derived from the first non-empty line, Markdown stripped. */
  title: string;
  /** Full note body with line endings normalized to "\n". */
  content: string;
  tags: string[];
  /** Simplenote system tags such as "markdown", "pinned", "published". */
  systemTags: string[];
  /** Simplenote flags this note for Markdown rendering. */
  isMarkdown: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  /** Simplenote/Simperium object version. */
  revision?: string;
}

export const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, "\n");
