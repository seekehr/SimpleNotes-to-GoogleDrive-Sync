import { ExternalHyperlink, type ParagraphChild } from "docx";
import type { PhrasingContent } from "mdast";
import type { HandlerRegistry, RenderContext, RunStyle } from "../context.js";

const BR_TAG = /^<br\s*\/?>$/i;

function hyperlink(ctx: RenderContext, url: string, children: readonly PhrasingContent[], style: RunStyle, fallbackText: string): ParagraphChild[] {
  const safe = ctx.safeUrl(url);
  if (!safe) {
    // Relative or unsafe (e.g. javascript:) targets are kept as plain text.
    return children.length ? ctx.renderInlines(children, style) : [ctx.textRun(fallbackText, style)];
  }
  const linkStyle = { ...style, link: true };
  const runs = children.length ? ctx.renderInlines(children, linkStyle) : [ctx.textRun(fallbackText || safe, linkStyle)];
  // Word cannot nest hyperlinks; if the label somehow contains one, flatten it.
  const flat = runs.flatMap((run) => (run instanceof ExternalHyperlink ? [] : [run]));
  return [new ExternalHyperlink({ link: safe, children: flat.length ? flat : [ctx.textRun(safe, linkStyle)] })];
}

export function registerInlineHandlers(registry: HandlerRegistry): void {
  registry
    .inline("text", (node, ctx, style) => [ctx.textRun(node.value, style)])
    .inline("strong", (node, ctx, style) => ctx.renderInlines(node.children, { ...style, bold: true }))
    .inline("emphasis", (node, ctx, style) => ctx.renderInlines(node.children, { ...style, italics: true }))
    .inline("delete", (node, ctx, style) => ctx.renderInlines(node.children, { ...style, strike: true }))
    .inline("inlineCode", (node, ctx, style) => [ctx.textRun(node.value, { ...style, code: true })])
    .inline("break", (_node, ctx, style) => [ctx.textRun("", style, { break: 1 })])
    .inline("link", (node, ctx, style) => hyperlink(ctx, node.url, node.children, style, node.url))
    .inline("linkReference", (node, ctx, style) => {
      const definition = ctx.definitions.get(node.identifier.toLowerCase());
      if (!definition) return ctx.renderInlines(node.children, style);
      return hyperlink(ctx, definition.url, node.children, style, definition.url);
    })
    .inline("image", (node, ctx, style) => {
      // Remote images are not downloaded; keep a clickable reference instead.
      const label = `[image${node.alt ? `: ${node.alt}` : ""}]`;
      return hyperlink(ctx, node.url, [], { ...style, italics: true }, label);
    })
    .inline("imageReference", (node, ctx, style) => {
      const definition = ctx.definitions.get(node.identifier.toLowerCase());
      const label = `[image${node.alt ? `: ${node.alt}` : ""}]`;
      return definition ? hyperlink(ctx, definition.url, [], { ...style, italics: true }, label) : [ctx.textRun(label, style)];
    })
    .inline("html", (node, ctx, style) =>
      BR_TAG.test(node.value.trim()) ? [ctx.textRun("", style, { break: 1 })] : [ctx.textRun(node.value, style)],
    )
    .inline("footnoteReference", (node, ctx, style) => [
      ctx.textRun(`[${ctx.footnoteNumber(node.identifier)}]`, { ...style, superScript: true }),
    ]);
}
