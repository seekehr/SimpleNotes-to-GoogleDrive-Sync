import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { configSchema, type DocumentConfig } from "../../src/config/schema.js";
import { DocxRenderer } from "../../src/docx/converter.js";
import type { Note } from "../../src/notes/note.js";

export interface RunInfo {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  font?: string;
  superScript: boolean;
  breaks: number;
  tab: boolean;
  shaded: boolean;
  hyperlink?: string;
}

export interface ParagraphInfo {
  kind: "p";
  style?: string;
  numId?: string;
  level?: number;
  hasBorder: boolean;
  borderSides: string[];
  shaded: boolean;
  indentLeft?: number;
  runs: RunInfo[];
  text: string;
}

export interface TableInfo {
  kind: "tbl";
  rows: { cells: { text: string; bold: boolean; shaded: boolean }[] }[];
}

type Node = Record<string, unknown> & { ":@"?: Record<string, string> };

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", trimValues: false, parseTagValue: false });

const tagOf = (node: Node): string => Object.keys(node).find((k) => k !== ":@") as string;
const childrenOf = (node: Node): Node[] => (node[tagOf(node)] as Node[]) ?? [];
const find = (nodes: Node[], tag: string): Node | undefined => nodes.find((n) => tagOf(n) === tag);
const attr = (node: Node | undefined, name: string): string | undefined => node?.[":@"]?.[name];

function textOf(nodes: Node[]): string {
  let out = "";
  for (const node of nodes) {
    if ("#text" in node) out += String(node["#text"]);
    else out += textOf(childrenOf(node));
  }
  return out;
}

function parseRun(run: Node, hyperlink?: string): RunInfo {
  const kids = childrenOf(run);
  const rPr = childrenOf(find(kids, "w:rPr") ?? ({ "w:rPr": [] } as Node));
  const has = (tag: string) => {
    const el = find(rPr, tag);
    return el !== undefined && attr(el, "w:val") !== "false" && attr(el, "w:val") !== "0";
  };
  return {
    text: kids.filter((k) => tagOf(k) === "w:t").map((k) => textOf(childrenOf(k))).join(""),
    bold: has("w:b"),
    italic: has("w:i"),
    strike: has("w:strike"),
    font: attr(find(rPr, "w:rFonts"), "w:ascii"),
    superScript: attr(find(rPr, "w:vertAlign"), "w:val") === "superscript",
    breaks: kids.filter((k) => tagOf(k) === "w:br").length,
    tab: kids.some((k) => tagOf(k) === "w:tab"),
    shaded: find(rPr, "w:shd") !== undefined,
    hyperlink,
  };
}

function collectRuns(nodes: Node[], rels: Map<string, string>, hyperlink?: string): RunInfo[] {
  const runs: RunInfo[] = [];
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "w:r") runs.push(parseRun(node, hyperlink));
    else if (tag === "w:hyperlink") runs.push(...collectRuns(childrenOf(node), rels, rels.get(attr(node, "r:id") ?? "") ?? "?"));
  }
  return runs;
}

function parseParagraph(p: Node, rels: Map<string, string>): ParagraphInfo {
  const kids = childrenOf(p);
  const pPr = childrenOf(find(kids, "w:pPr") ?? ({ "w:pPr": [] } as Node));
  const numPr = childrenOf(find(pPr, "w:numPr") ?? ({ "w:numPr": [] } as Node));
  const border = find(pPr, "w:pBdr");
  const runs = collectRuns(kids, rels);
  const ind = attr(find(pPr, "w:ind"), "w:left") ?? attr(find(pPr, "w:ind"), "w:start");
  return {
    kind: "p",
    style: attr(find(pPr, "w:pStyle"), "w:val"),
    numId: attr(find(numPr, "w:numId"), "w:val"),
    level: numPr.length ? Number(attr(find(numPr, "w:ilvl"), "w:val") ?? 0) : undefined,
    hasBorder: border !== undefined,
    borderSides: border ? childrenOf(border).map(tagOf) : [],
    shaded: find(pPr, "w:shd") !== undefined,
    indentLeft: ind ? Number(ind) : undefined,
    runs,
    text: runs.map((r) => r.text).join(""),
  };
}

function parseTable(tbl: Node, rels: Map<string, string>): TableInfo {
  return {
    kind: "tbl",
    rows: childrenOf(tbl)
      .filter((n) => tagOf(n) === "w:tr")
      .map((tr) => ({
        cells: childrenOf(tr)
          .filter((n) => tagOf(n) === "w:tc")
          .map((tc) => {
            const kids = childrenOf(tc);
            const paragraphs = kids.filter((n) => tagOf(n) === "w:p").map((p) => parseParagraph(p, rels));
            const tcPr = childrenOf(find(kids, "w:tcPr") ?? ({ "w:tcPr": [] } as Node));
            return {
              text: paragraphs.map((p) => p.text).join("\n"),
              bold: paragraphs.some((p) => p.runs.some((r) => r.bold)),
              shaded: find(tcPr, "w:shd") !== undefined,
            };
          }),
      })),
  };
}

export interface ParsedDocx {
  blocks: (ParagraphInfo | TableInfo)[];
  paragraphs: ParagraphInfo[];
  documentXml: string;
  numberingXml: string;
  coreXml: string;
}

export async function parseDocx(data: Buffer): Promise<ParsedDocx> {
  const zip = await JSZip.loadAsync(data);
  const documentXml = await zip.file("word/document.xml")!.async("string");
  const relsXml = (await zip.file("word/_rels/document.xml.rels")?.async("string")) ?? "";
  const numberingXml = (await zip.file("word/numbering.xml")?.async("string")) ?? "";
  const coreXml = (await zip.file("docProps/core.xml")?.async("string")) ?? "";

  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels.set(m[1] as string, m[2] as string);

  const doc = parser.parse(documentXml) as Node[];
  const root = find(doc, "w:document") as Node;
  const body = childrenOf(find(childrenOf(root), "w:body") as Node);
  const blocks: (ParagraphInfo | TableInfo)[] = [];
  for (const node of body) {
    const tag = tagOf(node);
    if (tag === "w:p") blocks.push(parseParagraph(node, rels));
    else if (tag === "w:tbl") blocks.push(parseTable(node, rels));
  }
  return {
    blocks,
    paragraphs: blocks.filter((b): b is ParagraphInfo => b.kind === "p"),
    documentXml,
    numberingXml,
    coreXml,
  };
}

export const defaultDocumentConfig = (overrides: Partial<DocumentConfig> = {}): DocumentConfig => ({
  ...configSchema.parse({}).document,
  ...overrides,
});

export function makeNote(content: string, overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    title: "Test",
    content,
    tags: [],
    systemTags: ["markdown"],
    isMarkdown: true,
    ...overrides,
  };
}

export async function renderMarkdown(markdown: string, config: Partial<DocumentConfig> = {}, note: Partial<Note> = {}) {
  const renderer = new DocxRenderer(defaultDocumentConfig(config));
  const result = await renderer.render(makeNote(markdown, note));
  return { ...(await parseDocx(result.data)), warnings: result.warnings, data: result.data };
}
