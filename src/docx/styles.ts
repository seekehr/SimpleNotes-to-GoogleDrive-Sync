import {
  AlignmentType,
  type ILevelsOptions,
  type INumberingOptions,
  type IStylesOptions,
  LevelFormat,
  LineRuleType,
  convertInchesToTwip,
} from "docx";
import type { DocumentConfig } from "../config/schema.js";

/** Word measures sizes in half-points and spacing/indents in twentieths of a point (twips). */
export const pt = (points: number): number => Math.round(points * 20);
export const halfPt = (points: number): number => Math.round(points * 2);

export const MAX_LIST_LEVEL = 8;
const BULLETS = ["•", "◦", "▪"];
const ORDERED_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];

export const BULLET_REFERENCE = "snsync-bullet";
export const orderedReference = (start: number): string => `snsync-ordered-${start}`;

/** Left indent (twips) of list content at the given 0-based nesting level. */
export function listIndent(config: DocumentConfig, level: number): number {
  return pt(config.lists.indent_pt * (level + 1));
}

function level(config: DocumentConfig, index: number, format: (typeof LevelFormat)[keyof typeof LevelFormat], text: string, start = 1): ILevelsOptions {
  return {
    level: index,
    format,
    text,
    start,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: {
        indent: { left: listIndent(config, index), hanging: pt(Math.min(config.lists.hanging_pt, config.lists.indent_pt)) },
        spacing: { after: pt(config.lists.spacing_after), before: 0 },
      },
    },
  };
}

/** Numbering definitions: one bullet list, plus one ordered list per distinct start number used. */
export function buildNumbering(config: DocumentConfig, orderedStarts: Iterable<number>): INumberingOptions {
  const levels = Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, i) => i);
  const bullet = levels.map((i) => level(config, i, LevelFormat.BULLET, BULLETS[i % BULLETS.length] as string));
  const ordered = (start: number) =>
    levels.map((i) =>
      level(config, i, ORDERED_FORMATS[i % ORDERED_FORMATS.length] as (typeof LevelFormat)[keyof typeof LevelFormat], `%${i + 1}.`, i === 0 ? start : 1),
    );
  const starts = new Set([1, ...orderedStarts]);
  return {
    config: [
      { reference: BULLET_REFERENCE, levels: bullet },
      ...[...starts].map((start) => ({ reference: orderedReference(start), levels: ordered(start) })),
    ],
  };
}

export function buildStyles(config: DocumentConfig): IStylesOptions {
  const h = config.headings;
  const headingFont = h.font || config.font;
  const heading = (index: number) => ({
    run: { font: headingFont, size: halfPt(h.sizes[index] ?? config.font_size), bold: h.bold, color: h.color },
    paragraph: {
      spacing: { before: pt(h.spacing_before), after: pt(h.spacing_after) },
      keepNext: true,
      keepLines: true,
    },
  });

  return {
    default: {
      document: {
        run: { font: config.font, size: halfPt(config.font_size), color: config.text_color },
        paragraph: {
          spacing: {
            before: pt(config.paragraph_spacing_before),
            after: pt(config.paragraph_spacing_after),
            line: Math.round(240 * config.line_spacing),
            lineRule: LineRuleType.AUTO,
          },
        },
      },
      heading1: heading(0),
      heading2: heading(1),
      heading3: heading(2),
      heading4: heading(3),
      heading5: heading(4),
      heading6: heading(5),
      hyperlink: { run: { color: config.link_color, underline: {} } },
      listParagraph: { paragraph: { contextualSpacing: true } },
    },
  };
}

export const PAGE_SIZES_TWIPS = {
  letter: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
  a4: { width: 11906, height: 16838 },
} as const;

export function pageSetup(config: DocumentConfig) {
  const m = config.page.margins_inches;
  return {
    size: PAGE_SIZES_TWIPS[config.page.size],
    margin: {
      top: convertInchesToTwip(m.top),
      right: convertInchesToTwip(m.right),
      bottom: convertInchesToTwip(m.bottom),
      left: convertInchesToTwip(m.left),
    },
  };
}

/** Usable text width in twips — used to give tables explicit column widths. */
export function contentWidth(config: DocumentConfig): number {
  const m = config.page.margins_inches;
  return PAGE_SIZES_TWIPS[config.page.size].width - convertInchesToTwip(m.left + m.right);
}
