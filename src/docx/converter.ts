import { Document, type FileChild, Packer, Paragraph } from "docx";
import type { Root } from "mdast";
import type { DocumentConfig } from "../config/schema.js";
import { AppError, DocxGenerationError, MarkdownConversionError, errorMessage } from "../errors.js";
import { parseMarkdown, plainTextToMdast } from "../markdown/parse.js";
import type { Note } from "../notes/note.js";
import { sha256, stableStringify } from "../util/hash.js";
import { type HandlerRegistry, ROOT_ENV, RenderContext, sanitizeXmlText } from "./context.js";
import { metadataBlock } from "./metadata.js";
import { createDefaultRegistry } from "./registry.js";
import { buildNumbering, buildStyles, pageSetup } from "./styles.js";

export interface RenderedDocument {
  data: Buffer;
  /** Non-fatal issues, e.g. Markdown constructs rendered as plain text. */
  warnings: string[];
}

/**
 * Output-format abstraction. DOCX is the only implementation today; another format
 * (PDF, Google Docs native, …) would implement this and plug into the sync engine.
 */
export interface DocumentRenderer {
  readonly extension: string;
  readonly mimeType: string;
  /** Changes whenever output for the same note would change (renderer version + styling config). */
  fingerprint(): string;
  render(note: Note): Promise<RenderedDocument>;
}

/**
 * Bump when converter changes alter the produced documents, so the next sync
 * regenerates and re-uploads every note once.
 */
export const DOCX_CONVERTER_VERSION = "1";

export const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export class DocxRenderer implements DocumentRenderer {
  readonly extension = ".docx";
  readonly mimeType = DOCX_MIME_TYPE;
  private readonly registry: HandlerRegistry;

  constructor(
    private readonly config: DocumentConfig,
    registry?: HandlerRegistry,
  ) {
    this.registry = registry ?? createDefaultRegistry();
  }

  fingerprint(): string {
    return sha256(`docx:${DOCX_CONVERTER_VERSION}:${stableStringify(this.config)}`);
  }

  private treatAsMarkdown(note: Note): boolean {
    const mode = this.config.markdown_mode;
    return mode === "always" || (mode === "auto" && note.isMarkdown);
  }

  /** Builds the docx object model. Exposed separately so tests can inspect structure. */
  buildDocument(note: Note): { document: Document; warnings: string[] } {
    let tree: Root;
    let ctx: RenderContext;
    let children: FileChild[];
    try {
      tree = this.treatAsMarkdown(note)
        ? parseMarkdown(note.content, { hardLineBreaks: this.config.hard_line_breaks })
        : plainTextToMdast(note.content);
      ctx = new RenderContext(this.config, this.registry, tree);
      children = ctx.renderBlocks(tree.children, ROOT_ENV);
      if (this.config.include_metadata) children.push(...metadataBlock(note, ctx));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new MarkdownConversionError(`DOCX conversion failed: ${errorMessage(error)}`, { cause: error });
    }
    // A document body must contain at least one paragraph to be valid.
    if (children.length === 0) children.push(new Paragraph({ children: [] }));

    try {
      const document = new Document({
        title: sanitizeXmlText(note.title),
        keywords: sanitizeXmlText(note.tags.join(", ")),
        creator: "notesync",
        description: `Simplenote note ${note.id}`,
        styles: buildStyles(this.config),
        numbering: buildNumbering(this.config, ctx.orderedStarts),
        sections: [{ properties: { page: pageSetup(this.config) }, children }],
      });
      return { document, warnings: ctx.warnings };
    } catch (error) {
      throw new DocxGenerationError(`DOCX generation failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  async render(note: Note): Promise<RenderedDocument> {
    const { document, warnings } = this.buildDocument(note);
    try {
      const data = await Packer.toBuffer(document);
      return { data, warnings };
    } catch (error) {
      throw new DocxGenerationError(`DOCX packaging failed: ${errorMessage(error)}`, { cause: error });
    }
  }
}
