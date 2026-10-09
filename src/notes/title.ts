import { toString } from "mdast-util-to-string";
import { parseMarkdown } from "../markdown/parse.js";

export const MAX_TITLE_LENGTH = 120;

/**
 * Derives a human title the way Simplenote does (first non-empty line), then strips
 * Markdown syntax with the real parser so "# **Project** notes" becomes "Project notes".
 */
export function deriveTitle(content: string): string {
  const firstLine = content.split("\n").find((line) => line.trim() !== "") ?? "";
  let title = firstLine.trim();
  if (title !== "") {
    const plain = toString(parseMarkdown(title, { hardLineBreaks: false }));
    // A line that is pure syntax (e.g. "---" or "```") has no text; keep the raw line instead.
    if (plain.trim() !== "") title = plain;
  }
  title = title.replace(/\s+/g, " ").trim();
  if (title.length > MAX_TITLE_LENGTH) {
    const cut = title.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    title = `${(lastSpace > MAX_TITLE_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return title || "Untitled";
}
