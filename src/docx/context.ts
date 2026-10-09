import { BorderStyle, type FileChild, type IParagraphOptions, Paragraph, type ParagraphChild, ShadingType, Tab, TextRun } from "docx";
import type { Definition, FootnoteDefinition, Nodes, PhrasingContent, Root, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import type { DocumentConfig } from "../config/schema.js";
import { pt } from "./styles.js";

/** Character formatting accumulated while descending through inline nodes. */
export interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
  superScript?: boolean;
  color?: string;
  sizePt?: number;
}

/** Layout state for block nodes (list nesting, blockquote depth, indentation). */
export interface BlockEnv {
  /** 0-based list nesting level of the enclosing list item; -1 outside lists. */
  listLevel: number;
  /** Left indent (twips) contributed by enclosing blockquotes. */
  baseIndent: number;
  /** Left indent (twips) for non-list content at this position (e.g. a list item's second paragraph). */
  contentIndent: number;
  quoteDepth: number;
}

export const ROOT_ENV: BlockEnv = { listLevel: -1, baseIndent: 0, contentIndent: 0, quoteDepth: 0 };

export type BlockHandler<T extends RootContent = RootContent> = (node: T, ctx: RenderContext, env: BlockEnv) => FileChild[];
export type InlineHandler<T extends PhrasingContent = PhrasingContent> = (node: T, ctx: RenderContext, style: RunStyle) => ParagraphChild[];

/**
 * Maps mdast node types to renderers. Adding support for a new Markdown construct
 * means registering one handler — nothing else in the pipeline changes.
 */
export class HandlerRegistry {
  private readonly blocks = new Map<string, BlockHandler<any>>();
  private readonly inlines = new Map<string, InlineHandler<any>>();

  block<K extends RootContent["type"]>(type: K, handler: BlockHandler<Extract<RootContent, { type: K }>>): this {
    this.blocks.set(type, handler);
    return this;
  }

  inline<K extends PhrasingContent["type"]>(type: K, handler: InlineHandler<Extract<PhrasingContent, { type: K }>>): this {
    this.inlines.set(type, handler);
    return this;
  }

  getBlock(type: string): BlockHandler | undefined {
    return this.blocks.get(type);
  }

  getInline(type: string): InlineHandler | undefined {
    return this.inlines.get(type);
  }
}

/** Characters that are illegal in XML 1.0 and would make Word refuse to open the file. */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const sanitizeXmlText = (text: string): string => text.replace(XML_INVALID, "");

const SAFE_URL = /^(https?:|mailto:|ftp:|tel:)/i;

export class RenderContext {
  readonly warnings: string[] = [];
  readonly orderedStarts = new Set<number>();
  readonly definitions = new Map<string, Definition>();
  readonly footnoteNumbers = new Map<string, number>();
  private instanceCounter = 0;

  constructor(
    readonly config: DocumentConfig,
    private readonly registry: HandlerRegistry,
    root?: Root,
  ) {
    if (root) this.collectDefinitions(root);
  }

  private collectDefinitions(node: Nodes): void {
    if (node.type === "definition") this.definitions.set(node.identifier.toLowerCase(), node);
    if (node.type === "footnoteDefinition") this.footnoteNumber((node as FootnoteDefinition).identifier);
    if ("children" in node) for (const child of node.children) this.collectDefinitions(child as Nodes);
  }

  footnoteNumber(identifier: string): number {
    const key = identifier.toLowerCase();
    let n = this.footnoteNumbers.get(key);
    if (n === undefined) {
      n = this.footnoteNumbers.size + 1;
      this.footnoteNumbers.set(key, n);
    }
    return n;
  }

  /** A fresh numbering instance so each ordered list restarts at its own start number. */
  newNumberingInstance(): number {
    return ++this.instanceCounter;
  }

  safeUrl(url: string): string | undefined {
    const trimmed = url.trim();
    return SAFE_URL.test(trimmed) ? trimmed : undefined;
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  renderBlocks(nodes: readonly RootContent[], env: BlockEnv): FileChild[] {
    const out: FileChild[] = [];
    for (const node of nodes) {
      const handler = this.registry.getBlock(node.type);
      if (handler) {
        out.push(...handler(node, this, env));
        continue;
      }
      // Unknown construct: degrade to its plain text rather than failing the note.
      const text = toString(node);
      this.warn(`Unsupported Markdown block "${node.type}" rendered as plain text`);
      if (text.trim() !== "") out.push(this.paragraph([this.textRun(text, this.baseStyle(env))], env));
    }
    return out;
  }

  renderInlines(nodes: readonly PhrasingContent[], style: RunStyle): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    for (const node of nodes) {
      const handler = this.registry.getInline(node.type);
      if (handler) {
        out.push(...handler(node, this, style));
        continue;
      }
      this.warn(`Unsupported Markdown inline "${node.type}" rendered as plain text`);
      out.push(this.textRun(toString(node), style));
    }
    return out;
  }

  /** Inline style implied by the block position (e.g. muted text inside a quote). */
  baseStyle(env: BlockEnv): RunStyle {
    return env.quoteDepth > 0 ? { color: this.config.blockquote.text_color } : {};
  }

  textRun(text: string, style: RunStyle, extra: { break?: number } = {}): TextRun {
    const c = this.config;
    return new TextRun({
      text: sanitizeXmlText(text),
      break: extra.break,
      bold: style.bold || undefined,
      italics: style.italics || undefined,
      strike: style.strike || undefined,
      superScript: style.superScript || undefined,
      font: style.code ? c.code_font : undefined,
      size: style.code ? c.code_font_size * 2 : style.sizePt ? style.sizePt * 2 : undefined,
      shading: style.code && !style.link ? { type: ShadingType.CLEAR, fill: c.code.inline_background, color: "auto" } : undefined,
      color: style.link ? c.link_color : style.color,
      underline: style.link ? {} : undefined,
      style: style.link ? "Hyperlink" : undefined,
    });
  }

  /** A marker glyph (e.g. a checkbox) followed by a tab to the hanging-indent text position. */
  glyphRun(glyph: string, font: string): TextRun {
    return new TextRun({ children: [glyph, new Tab()], font });
  }

  /** Creates a paragraph honouring the current indentation and blockquote decoration. */
  paragraph(children: ParagraphChild[], env: BlockEnv, options: Omit<IParagraphOptions, "children"> = {}): Paragraph {
    const quoteBorder =
      env.quoteDepth > 0
        ? { left: { style: BorderStyle.SINGLE, size: 12, color: this.config.blockquote.border_color, space: 8 } }
        : undefined;
    return new Paragraph({
      ...options,
      children,
      indent: options.indent ?? (env.contentIndent > 0 ? { left: env.contentIndent } : undefined),
      border: options.border ?? quoteBorder,
    });
  }

  quoteIndent(): number {
    return pt(this.config.blockquote.indent_pt);
  }
}
