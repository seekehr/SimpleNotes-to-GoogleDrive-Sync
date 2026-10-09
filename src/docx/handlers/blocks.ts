import { BorderStyle, type FileChild, HeadingLevel, LineRuleType, Paragraph, ShadingType } from "docx";
import type { BlockEnv, HandlerRegistry, RenderContext } from "../context.js";
import { pt } from "../styles.js";

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** A fenced or indented code block: monospaced, shaded and boxed, whitespace preserved. */
export function codeBlock(ctx: RenderContext, value: string, env: BlockEnv): Paragraph {
  const c = ctx.config;
  const lines = value.replace(/\t/g, "    ").split("\n");
  const border = { style: BorderStyle.SINGLE, size: 4, color: c.code.border_color, space: 4 };
  return new Paragraph({
    children: lines.map((line, i) => ctx.textRun(line, { code: true }, { break: i > 0 ? 1 : undefined })),
    shading: { type: ShadingType.CLEAR, fill: c.code.background, color: "auto" },
    border: { top: border, bottom: border, left: border, right: border },
    indent: { left: env.contentIndent + pt(5), right: pt(5) },
    spacing: { before: pt(4), after: pt(10), line: 240, lineRule: LineRuleType.AUTO },
  });
}

export function registerBlockHandlers(registry: HandlerRegistry): void {
  registry
    .block("paragraph", (node, ctx, env) => [ctx.paragraph(ctx.renderInlines(node.children, ctx.baseStyle(env)), env)])
    .block("heading", (node, ctx, env) => [
      ctx.paragraph(ctx.renderInlines(node.children, ctx.baseStyle(env)), env, {
        heading: HEADINGS[Math.min(Math.max(node.depth, 1), 6) - 1],
      }),
    ])
    .block("thematicBreak", (_node, ctx, env) => [
      ctx.paragraph([], env, {
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 } },
        spacing: { before: pt(6), after: pt(12) },
      }),
    ])
    .block("code", (node, ctx, env) => [codeBlock(ctx, node.value, env)])
    // Raw HTML is shown literally: Word cannot render it and silently dropping text is worse.
    .block("html", (node, ctx, env) => [ctx.paragraph([ctx.textRun(node.value, ctx.baseStyle(env))], env)])
    .block("blockquote", (node, ctx, env) => {
      const indent = ctx.quoteIndent();
      return ctx.renderBlocks(node.children, {
        ...env,
        quoteDepth: env.quoteDepth + 1,
        baseIndent: env.baseIndent + indent,
        contentIndent: env.contentIndent + indent,
      });
    })
    // Link reference definitions are resolved by linkReference; they render nothing.
    .block("definition", () => [])
    .block("footnoteDefinition", (node, ctx, env) => {
      const label = ctx.textRun(`[${ctx.footnoteNumber(node.identifier)}] `, { superScript: true });
      const out: FileChild[] = [];
      node.children.forEach((child, i) => {
        if (i === 0 && child.type === "paragraph") {
          out.push(
            ctx.paragraph([label, ...ctx.renderInlines(child.children, { sizePt: Math.max(ctx.config.font_size - 1, 6) })], env),
          );
        } else {
          out.push(...ctx.renderBlocks([child], env));
        }
      });
      return out;
    });
}
