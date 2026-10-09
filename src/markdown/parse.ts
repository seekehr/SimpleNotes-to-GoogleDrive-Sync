import type { Break, Paragraph, Root, RootContent, Text } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { MarkdownConversionError, errorMessage } from "../errors.js";

export interface ParseOptions {
  /** Treat single newlines inside a paragraph as hard line breaks (Simplenote's rendering). */
  hardLineBreaks: boolean;
}

// GFM adds tables, strikethrough, task lists, autolinked plain URLs and footnotes.
const gfmProcessor = unified().use(remarkParse).use(remarkGfm).freeze();
const gfmBreaksProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks).freeze();

/** Parses Markdown into an mdast syntax tree using a real CommonMark/GFM parser. */
export function parseMarkdown(markdown: string, options: ParseOptions): Root {
  const processor = options.hardLineBreaks ? gfmBreaksProcessor : gfmProcessor;
  try {
    return processor.runSync(processor.parse(markdown)) as Root;
  } catch (error) {
    throw new MarkdownConversionError(`Markdown parsing failed: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Builds the same tree shape for a plain-text note: blank lines separate paragraphs,
 * single newlines become line breaks, and no character has Markdown meaning.
 */
export function plainTextToMdast(text: string): Root {
  const children: RootContent[] = [];
  for (const block of text.split(/\n{2,}/)) {
    if (block.trim() === "") continue;
    const lines = block.split("\n");
    const inline: (Text | Break)[] = [];
    lines.forEach((line, i) => {
      if (i > 0) inline.push({ type: "break" });
      if (line !== "") inline.push({ type: "text", value: line });
    });
    children.push({ type: "paragraph", children: inline } satisfies Paragraph);
  }
  return { type: "root", children };
}
