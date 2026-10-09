import { BorderStyle, type FileChild, Paragraph, Table, TableCell, TableRow, WidthType } from "docx";
import type { Note } from "../notes/note.js";
import type { RenderContext } from "./context.js";
import { contentWidth, pt } from "./styles.js";

const MUTED = "666666";

/** Optional trailing block listing the note's Simplenote metadata (document.include_metadata). */
export function metadataBlock(note: Note, ctx: RenderContext): FileChild[] {
  const size = Math.max(ctx.config.font_size - 2, 7);
  const rows: [string, string][] = [
    ["Simplenote ID", note.id],
    ["Created", note.createdAt?.toISOString() ?? "—"],
    ["Updated", note.updatedAt?.toISOString() ?? "—"],
    ["Tags", note.tags.length ? note.tags.join(", ") : "—"],
    ["Revision", note.revision ?? "—"],
  ];
  const width = contentWidth(ctx.config);
  const labelWidth = Math.round(width * 0.25);
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };

  return [
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 } },
      spacing: { before: pt(18), after: pt(6) },
      children: [],
    }),
    new Table({
      width: { size: width, type: WidthType.DXA },
      columnWidths: [labelWidth, width - labelWidth],
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
      rows: rows.map(
        ([label, value]) =>
          new TableRow({
            children: [label, value].map(
              (text, i) =>
                new TableCell({
                  width: { size: i === 0 ? labelWidth : width - labelWidth, type: WidthType.DXA },
                  children: [
                    new Paragraph({
                      spacing: { before: 0, after: 0 },
                      children: [ctx.textRun(text, { color: MUTED, sizePt: size, bold: i === 0 || undefined })],
                    }),
                  ],
                }),
            ),
          }),
      ),
    }),
  ];
}
