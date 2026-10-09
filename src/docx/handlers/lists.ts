import type { FileChild, IParagraphOptions, ParagraphChild } from "docx";
import type { List, ListItem } from "mdast";
import type { BlockEnv, HandlerRegistry, RenderContext } from "../context.js";
import { BULLET_REFERENCE, MAX_LIST_LEVEL, listIndent, orderedReference, pt } from "../styles.js";

const CHECKBOX_FONT = "Segoe UI Symbol";

/**
 * Renders one list item. Its first paragraph carries the bullet/number (or a
 * checkbox for task items); later blocks are indented to line up with the text.
 */
function renderItem(
  item: ListItem,
  ctx: RenderContext,
  env: BlockEnv,
  level: number,
  numbering: { reference: string; instance: number },
): FileChild[] {
  const itemEnv: BlockEnv = { ...env, listLevel: level, contentIndent: env.baseIndent + listIndent(ctx.config, level) };
  const style = ctx.baseStyle(env);
  const isTask = item.checked === true || item.checked === false;
  const hanging = pt(Math.min(ctx.config.lists.hanging_pt, ctx.config.lists.indent_pt));

  const markerOptions = (): Omit<IParagraphOptions, "children"> =>
    isTask
      ? { indent: { left: itemEnv.contentIndent, hanging } }
      : {
          numbering: { reference: numbering.reference, level, instance: numbering.instance },
          // Explicit indent (equal to the numbering level's own indent outside quotes)
          // keeps text aligned when the list sits inside a blockquote.
          indent: { left: itemEnv.contentIndent, hanging },
        };

  const marker = (children: ParagraphChild[]) => {
    const prefix: ParagraphChild[] = isTask
      ? [ctx.glyphRun(item.checked ? "☑" : "☐", CHECKBOX_FONT)]
      : [];
    return ctx.paragraph([...prefix, ...children], env, {
      ...markerOptions(),
      spacing: { after: pt(ctx.config.lists.spacing_after) },
    });
  };

  const out: FileChild[] = [];
  const [first, ...rest] = item.children;

  if (!first) {
    out.push(marker([]));
  } else if (first.type === "paragraph") {
    out.push(marker(ctx.renderInlines(first.children, style)));
  } else if (first.type === "heading") {
    out.push(marker(ctx.renderInlines(first.children, { ...style, bold: true })));
  } else {
    // e.g. an item that starts with a code block: emit the marker on its own line.
    out.push(marker([]));
    rest.unshift(first);
  }

  for (const child of rest) {
    if (child.type === "paragraph") {
      out.push(
        ctx.paragraph(ctx.renderInlines(child.children, style), itemEnv, {
          spacing: { after: pt(ctx.config.lists.spacing_after) },
        }),
      );
    } else {
      out.push(...ctx.renderBlocks([child], itemEnv));
    }
  }
  return out;
}

export function registerListHandlers(registry: HandlerRegistry): void {
  registry.block("list", (node: List, ctx, env) => {
    const level = Math.min(env.listLevel + 1, MAX_LIST_LEVEL);
    let numbering: { reference: string; instance: number };
    if (node.ordered) {
      const start = node.start ?? 1;
      ctx.orderedStarts.add(start);
      numbering = { reference: orderedReference(start), instance: ctx.newNumberingInstance() };
    } else {
      numbering = { reference: BULLET_REFERENCE, instance: 0 };
    }
    return node.children.flatMap((item) => renderItem(item, ctx, env, level, numbering));
  });
}
