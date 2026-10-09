import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DocxRenderer } from "../../src/docx/converter.js";
import { type ParagraphInfo, type TableInfo, defaultDocumentConfig, makeNote, renderMarkdown } from "../helpers/docx.js";

const runsWith = (p: ParagraphInfo | undefined, text: string) => p?.runs.filter((r) => r.text === text) ?? [];
const para = (doc: { paragraphs: ParagraphInfo[] }, text: string) => doc.paragraphs.find((p) => p.text.includes(text));

describe("inline formatting", () => {
  it("turns **bold** into a bold run without the asterisks", async () => {
    const doc = await renderMarkdown("**hello**");
    const p = doc.paragraphs[0]!;
    expect(p.text).toBe("hello");
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]).toMatchObject({ text: "hello", bold: true, italic: false });
    expect(doc.documentXml).not.toContain("**");
  });

  it("turns *italic* and _italic_ into italic runs", async () => {
    const doc = await renderMarkdown("a *one* b _two_");
    const p = doc.paragraphs[0]!;
    expect(runsWith(p, "one")[0]).toMatchObject({ italic: true, bold: false });
    expect(runsWith(p, "two")[0]).toMatchObject({ italic: true, bold: false });
    expect(p.text).toBe("a one b two");
  });

  it("combines bold and italic for ***text*** and nested emphasis", async () => {
    const doc = await renderMarkdown("***both*** and **bold *inner* bold**");
    const p = doc.paragraphs[0]!;
    expect(runsWith(p, "both")[0]).toMatchObject({ bold: true, italic: true });
    expect(runsWith(p, "inner")[0]).toMatchObject({ bold: true, italic: true });
    expect(runsWith(p, "bold ")[0]).toMatchObject({ bold: true, italic: false });
  });

  it("renders ~~strikethrough~~", async () => {
    const doc = await renderMarkdown("~~gone~~ kept");
    expect(runsWith(doc.paragraphs[0], "gone")[0]).toMatchObject({ strike: true });
    expect(runsWith(doc.paragraphs[0], " kept")[0]).toMatchObject({ strike: false });
  });

  it("renders inline code in the code font with shading", async () => {
    const doc = await renderMarkdown("run `npm test` now");
    const run = runsWith(doc.paragraphs[0], "npm test")[0];
    expect(run).toMatchObject({ font: "Consolas", shaded: true });
    expect(doc.paragraphs[0]!.text).toBe("run npm test now");
  });

  it("creates real hyperlinks for links and plain URLs", async () => {
    const doc = await renderMarkdown("[OpenAI](https://openai.com) and https://example.com/x?y=1 here");
    const p = doc.paragraphs[0]!;
    expect(runsWith(p, "OpenAI")[0]).toMatchObject({ hyperlink: "https://openai.com" });
    expect(runsWith(p, "https://example.com/x?y=1")[0]?.hyperlink).toBe("https://example.com/x?y=1");
    expect(p.text).toBe("OpenAI and https://example.com/x?y=1 here");
  });

  it("resolves reference-style links", async () => {
    const doc = await renderMarkdown("See [docs][d].\n\n[d]: https://docs.example.com");
    expect(runsWith(doc.paragraphs[0], "docs")[0]?.hyperlink).toBe("https://docs.example.com");
    expect(doc.paragraphs).toHaveLength(1);
  });

  it("keeps unsafe or relative link targets as plain text", async () => {
    const doc = await renderMarkdown("[x](javascript:alert(1)) [y](./relative)");
    expect(doc.paragraphs[0]!.runs.every((r) => r.hyperlink === undefined)).toBe(true);
    expect(doc.paragraphs[0]!.text).toBe("x y");
  });

  it("keeps formatting inside link text", async () => {
    const doc = await renderMarkdown("[**bold link**](https://a.example)");
    expect(doc.paragraphs[0]!.runs[0]).toMatchObject({ text: "bold link", bold: true, hyperlink: "https://a.example" });
  });
});

describe("paragraphs and line breaks", () => {
  it("separates paragraphs on blank lines", async () => {
    const doc = await renderMarkdown("first\n\nsecond");
    expect(doc.paragraphs.map((p) => p.text)).toEqual(["first", "second"]);
  });

  it("turns single newlines into line breaks by default (Simplenote behaviour)", async () => {
    const doc = await renderMarkdown("line one\nline two");
    expect(doc.paragraphs).toHaveLength(1);
    expect(doc.paragraphs[0]!.runs.some((r) => r.breaks > 0)).toBe(true);
    expect(doc.paragraphs[0]!.text).toBe("line oneline two");
  });

  it("joins soft-wrapped lines when hard_line_breaks is off", async () => {
    const doc = await renderMarkdown("line one\nline two", { hard_line_breaks: false });
    expect(doc.paragraphs[0]!.runs.some((r) => r.breaks > 0)).toBe(false);
  });

  it("honours explicit hard breaks (two trailing spaces)", async () => {
    const doc = await renderMarkdown("a  \nb", { hard_line_breaks: false });
    expect(doc.paragraphs[0]!.runs.some((r) => r.breaks > 0)).toBe(true);
  });
});

describe("headings", () => {
  it("maps # through ###### to Word heading styles", async () => {
    const md = [1, 2, 3, 4, 5, 6].map((n) => `${"#".repeat(n)} Level ${n}`).join("\n\n");
    const doc = await renderMarkdown(md);
    expect(doc.paragraphs.map((p) => p.style)).toEqual(["Heading1", "Heading2", "Heading3", "Heading4", "Heading5", "Heading6"]);
    expect(doc.paragraphs.map((p) => p.text)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Level ${n}`));
    expect(doc.documentXml).not.toMatch(/>#/);
  });

  it("keeps inline formatting inside headings", async () => {
    const doc = await renderMarkdown("## A *styled* heading");
    expect(runsWith(doc.paragraphs[0], "styled")[0]).toMatchObject({ italic: true });
  });
});

describe("lists", () => {
  it("renders unordered lists as Word bullet numbering", async () => {
    const doc = await renderMarkdown("- one\n- two\n- three");
    expect(doc.paragraphs.map((p) => p.text)).toEqual(["one", "two", "three"]);
    const ids = new Set(doc.paragraphs.map((p) => p.numId));
    expect(ids.size).toBe(1);
    expect(doc.paragraphs.every((p) => p.level === 0)).toBe(true);
    expect(doc.numberingXml).toContain('w:numFmt w:val="bullet"');
  });

  it("renders ordered lists with decimal numbering", async () => {
    const doc = await renderMarkdown("1. one\n2. two");
    expect(doc.paragraphs.every((p) => p.numId !== undefined && p.level === 0)).toBe(true);
    expect(doc.numberingXml).toContain('w:numFmt w:val="decimal"');
  });

  it("nests lists with increasing levels and indentation", async () => {
    const doc = await renderMarkdown("- top\n  - middle\n    - bottom\n- top2");
    const levels = doc.paragraphs.map((p) => [p.text, p.level]);
    expect(levels).toEqual([["top", 0], ["middle", 1], ["bottom", 2], ["top2", 0]]);
    const [top, middle, bottom] = doc.paragraphs;
    expect(middle!.indentLeft!).toBeGreaterThan(top!.indentLeft!);
    expect(bottom!.indentLeft!).toBeGreaterThan(middle!.indentLeft!);
  });

  it("restarts numbering for separate ordered lists and honours the start number", async () => {
    const doc = await renderMarkdown("1. a\n2. b\n\nparagraph\n\n1. c\n\nparagraph\n\n7. d");
    const items = doc.paragraphs.filter((p) => p.numId);
    expect(items[0]!.numId).toBe(items[1]!.numId);
    expect(items[2]!.numId).not.toBe(items[0]!.numId);
    expect(items[3]!.numId).not.toBe(items[2]!.numId);
    expect(doc.numberingXml).toContain('w:start w:val="7"');
  });

  it("renders mixed ordered lists nested inside bullets", async () => {
    const doc = await renderMarkdown("- bullet\n  1. first\n  2. second");
    expect(doc.paragraphs.map((p) => p.level)).toEqual([0, 1, 1]);
    expect(doc.paragraphs[1]!.numId).not.toBe(doc.paragraphs[0]!.numId);
  });

  it("renders task list items with checkbox glyphs instead of [ ] markers", async () => {
    const doc = await renderMarkdown("- [ ] open\n- [x] done");
    expect(doc.paragraphs[0]!.text).toBe("☐open");
    expect(doc.paragraphs[1]!.text).toBe("☑done");
    expect(doc.paragraphs[0]!.runs[0]!.tab).toBe(true);
    expect(doc.documentXml).not.toContain("[ ]");
    expect(doc.documentXml).not.toContain("[x]");
  });

  it("indents continuation paragraphs inside list items", async () => {
    const doc = await renderMarkdown("- item\n\n  continued\n- next");
    const continued = para(doc, "continued")!;
    expect(continued.numId).toBeUndefined();
    expect(continued.indentLeft).toBe(para(doc, "item")!.indentLeft);
  });

  it("keeps the bullet when an item starts with a heading", async () => {
    const doc = await renderMarkdown("- # Big item");
    expect(doc.paragraphs[0]).toMatchObject({ text: "Big item" });
    expect(doc.paragraphs[0]!.numId).toBeDefined();
    expect(doc.paragraphs[0]!.runs[0]!.bold).toBe(true);
  });
});

describe("block elements", () => {
  it("renders blockquotes with a left border and muted text", async () => {
    const doc = await renderMarkdown("> Remember to handle API failures.");
    const p = doc.paragraphs[0]!;
    expect(p.text).toBe("Remember to handle API failures.");
    expect(p.borderSides).toContain("w:left");
    expect(p.indentLeft).toBeGreaterThan(0);
    expect(doc.documentXml).not.toContain("&gt; Remember");
  });

  it("supports lists and nesting inside blockquotes", async () => {
    const doc = await renderMarkdown("> - item\n>\n> > deeper");
    expect(para(doc, "item")!.numId).toBeDefined();
    expect(para(doc, "item")!.hasBorder).toBe(true);
    expect(para(doc, "deeper")!.indentLeft!).toBeGreaterThan(para(doc, "item")!.indentLeft! - 400);
  });

  it("renders fenced code blocks monospaced, boxed, preserving lines and indentation", async () => {
    const doc = await renderMarkdown("```ts\nconst x = 1;\n  indented();\n\tTabbed();\n```");
    const p = doc.paragraphs[0]!;
    expect(p.shaded).toBe(true);
    expect(p.borderSides).toEqual(expect.arrayContaining(["w:top", "w:bottom", "w:left", "w:right"]));
    expect(p.runs.every((r) => r.font === "Consolas")).toBe(true);
    expect(p.runs.map((r) => r.text)).toEqual(["const x = 1;", "  indented();", "    Tabbed();"]);
    expect(p.runs.slice(1).every((r) => r.breaks === 1)).toBe(true);
    expect(doc.documentXml).not.toContain("```");
  });

  it("does not interpret Markdown inside code blocks", async () => {
    const doc = await renderMarkdown("```\n**not bold**\n```");
    expect(doc.paragraphs[0]!.runs[0]).toMatchObject({ text: "**not bold**", bold: false });
  });

  it("renders horizontal rules as a bordered empty paragraph", async () => {
    const doc = await renderMarkdown("above\n\n---\n\nbelow");
    expect(doc.paragraphs[1]).toMatchObject({ text: "", borderSides: ["w:bottom"] });
  });

  it("renders raw HTML literally, but <br> as a line break", async () => {
    const doc = await renderMarkdown("a<br>b\n\n<div>block</div>");
    expect(doc.paragraphs[0]!.runs.some((r) => r.breaks > 0)).toBe(true);
    expect(doc.paragraphs[1]!.text).toBe("<div>block</div>");
  });
});

describe("tables", () => {
  const tables = (doc: { blocks: unknown[] }) => doc.blocks.filter((b): b is TableInfo => (b as TableInfo).kind === "tbl");

  it("renders GFM tables as Word tables with a bold, shaded header", async () => {
    const doc = await renderMarkdown("| Name | Qty |\n|:-----|----:|\n| apple | 3 |\n| **pear** | 5 |");
    const [table] = tables(doc);
    expect(table!.rows).toHaveLength(3);
    expect(table!.rows[0]!.cells.map((c) => c.text)).toEqual(["Name", "Qty"]);
    expect(table!.rows[0]!.cells.every((c) => c.bold && c.shaded)).toBe(true);
    expect(table!.rows[2]!.cells[0]).toMatchObject({ text: "pear", bold: true });
    expect(table!.rows[1]!.cells[1]).toMatchObject({ text: "3", bold: false, shaded: false });
    expect(doc.documentXml).toContain('w:jc w:val="right"');
  });

  it("normalizes ragged rows instead of failing", async () => {
    const doc = await renderMarkdown("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 |");
    const [table] = tables(doc);
    expect(table!.rows.map((r) => r.cells.length)).toEqual([3, 3, 3]);
    expect(table!.rows[1]!.cells.map((c) => c.text)).toEqual(["1", "", ""]);
  });
});

describe("document level", () => {
  it("converts the README example into real Word formatting", async () => {
    const md = [
      "# Project Notes",
      "",
      "This is **important** and this is *emphasized*.",
      "",
      "## Tasks",
      "",
      "- Build scraper",
      "- Add **Google Drive** integration",
      "- Test synchronization",
      "",
      "> Remember to handle API failures.",
      "",
      "[OpenAI](https://openai.com)",
    ].join("\n");
    const doc = await renderMarkdown(md);
    expect(doc.paragraphs.map((p) => p.text)).toEqual([
      "Project Notes",
      "This is important and this is emphasized.",
      "Tasks",
      "Build scraper",
      "Add Google Drive integration",
      "Test synchronization",
      "Remember to handle API failures.",
      "OpenAI",
    ]);
    expect(runsWith(doc.paragraphs[4], "Google Drive")[0]?.bold).toBe(true);
    expect(doc.documentXml).not.toMatch(/\*\*|^#|\]\(/m);
  });

  it("renders the kitchen-sink fixture without warnings", async () => {
    const md = readFileSync(new URL("../fixtures/kitchen-sink.md", import.meta.url), "utf8");
    const doc = await renderMarkdown(md);
    expect(doc.warnings).toEqual([]);
    expect(doc.data.subarray(0, 2).toString()).toBe("PK");
    expect(doc.documentXml).not.toContain("**");
  });

  it("strips characters that are illegal in XML so Word can open the file", async () => {
    const doc = await renderMarkdown("bell\u0007 and vertical\u000Btab and lone \uD800 surrogate");
    expect(doc.paragraphs[0]!.text).toBe("bell and verticaltab and lone  surrogate");
  });

  it("produces a valid document for an empty note", async () => {
    const doc = await renderMarkdown("");
    expect(doc.paragraphs.length).toBeGreaterThanOrEqual(1);
  });

  it("renders non-Markdown notes as plain text in auto mode", async () => {
    const doc = await renderMarkdown("**not bold**\nline 2\n\n# not heading", {}, { isMarkdown: false, systemTags: [] });
    expect(doc.paragraphs[0]!.runs.some((r) => r.bold)).toBe(false);
    expect(doc.paragraphs[0]!.text).toBe("**not bold**line 2");
    expect(doc.paragraphs[1]).toMatchObject({ text: "# not heading", style: undefined });
  });

  it("parses Markdown for every note with markdown_mode: always", async () => {
    const doc = await renderMarkdown("**bold**", { markdown_mode: "always" }, { isMarkdown: false });
    expect(doc.paragraphs[0]!.runs[0]!.bold).toBe(true);
  });

  it("appends the metadata table only when include_metadata is on", async () => {
    const meta = { id: "abc123", tags: ["work"], revision: "42", createdAt: new Date("2026-01-01T00:00:00Z") };
    const without = await renderMarkdown("body", {}, meta);
    expect(without.documentXml).not.toContain("abc123");
    const withMeta = await renderMarkdown("body", { include_metadata: true }, meta);
    expect(withMeta.documentXml).toContain("abc123");
    expect(withMeta.documentXml).toContain("work");
    expect(withMeta.documentXml).toContain("2026-01-01T00:00:00.000Z");
  });

  it("sets document properties from the note", async () => {
    const doc = await renderMarkdown("x", {}, { title: "My <Title>", tags: ["a", "b"] });
    expect(doc.coreXml).toContain("My &lt;Title&gt;");
    expect(doc.coreXml).toContain("a, b");
  });

  it("applies configurable fonts and sizes", async () => {
    const renderer = new DocxRenderer(defaultDocumentConfig({ font: "Calibri", font_size: 12 }));
    const { data } = await renderer.render(makeNote("x"));
    const { default: JSZip } = await import("jszip");
    const styles = await (await JSZip.loadAsync(data)).file("word/styles.xml")!.async("string");
    expect(styles).toContain('w:ascii="Calibri"');
    expect(styles).toContain('<w:sz w:val="24"/>');
  });

  it("changes its fingerprint when styling changes", () => {
    const a = new DocxRenderer(defaultDocumentConfig()).fingerprint();
    const b = new DocxRenderer(defaultDocumentConfig({ font_size: 12 })).fingerprint();
    expect(a).not.toBe(b);
    expect(new DocxRenderer(defaultDocumentConfig()).fingerprint()).toBe(a);
  });
});
