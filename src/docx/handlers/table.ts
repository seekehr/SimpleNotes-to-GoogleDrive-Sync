import {
  AlignmentType,
  BorderStyle,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  WidthType,
} from "docx";
import type { AlignType, Table as MdTable } from "mdast";
import type { HandlerRegistry } from "../context.js";
import { contentWidth, pt } from "../styles.js";

const ALIGN: Record<NonNullable<AlignType>, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};

export function registerTableHandlers(registry: HandlerRegistry): void {
  registry.block("table", (node: MdTable, ctx, env) => {
    const c = ctx.config;
    // Ragged rows (fewer/more cells than the header) are normalized to a rectangle
    // instead of producing a malformed Word table.
    const columns = Math.max(0, ...node.children.map((row) => row.children.length));
    if (columns === 0) return [];

    const available = Math.max(contentWidth(c) - env.contentIndent, pt(72));
    const columnWidth = Math.floor(available / columns);
    const border = { style: BorderStyle.SINGLE, size: 4, color: c.table.border_color };
    const padding = pt(c.table.cell_padding_pt);

    const rows = node.children.map((row, rowIndex) => {
      const header = rowIndex === 0;
      const cells = Array.from({ length: columns }, (_, col) => {
        const cell = row.children[col];
        const style = { ...ctx.baseStyle(env), bold: header && c.table.header_bold ? true : undefined };
        return new TableCell({
          width: { size: columnWidth, type: WidthType.DXA },
          margins: { top: padding, bottom: padding, left: padding * 1.5, right: padding * 1.5 },
          shading: header ? { type: ShadingType.CLEAR, fill: c.table.header_background, color: "auto" } : undefined,
          children: [
            new Paragraph({
              alignment: ALIGN[node.align?.[col] ?? "left"] ?? AlignmentType.LEFT,
              spacing: { before: 0, after: 0 },
              children: cell ? ctx.renderInlines(cell.children, style) : [],
            }),
          ],
        });
      });
      return new TableRow({ tableHeader: header, cantSplit: true, children: cells });
    });

    return [
      new Table({
        rows,
        width: { size: columnWidth * columns, type: WidthType.DXA },
        columnWidths: Array.from({ length: columns }, () => columnWidth),
        indent: env.contentIndent > 0 ? { size: env.contentIndent, type: WidthType.DXA } : undefined,
        borders: {
          top: border,
          bottom: border,
          left: border,
          right: border,
          insideHorizontal: border,
          insideVertical: border,
        },
      }),
      // Word glues the next paragraph to the table; a spacer keeps the layout readable.
      new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }),
    ];
  });
}
