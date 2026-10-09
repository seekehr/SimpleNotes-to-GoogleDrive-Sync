#!/usr/bin/env node
// Test double for SimpleNotesScraper. Reproduces the real tool's observable
// behaviour: wipes ./output, writes "<sanitized title>.txt" per note, prints a
// console.dir NOTES listing (with util.inspect truncation) and exits 0.
// Behaviour is selected with FAKE_SCRAPER_MODE; notes come from FAKE_SCRAPER_NOTES (JSON file).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: simplenotesscraper [--env-dir <directory>]");
  process.exit(0);
}
const mode = process.env.FAKE_SCRAPER_MODE ?? "ok";

if (mode === "hang") {
  console.log("connected");
  setInterval(() => {}, 1000);
} else if (mode === "crash") {
  throw new Error("TOKEN and GMAIL must be set in .env");
} else if (mode === "no-listing") {
  console.log("connected");
  console.log('RECV: 0:auth:{"msg": "Token invalid", "code": 401}');
  console.error("ws error: Error: Unexpected server response: 401");
  console.log("closed: 1006");
} else {
  const outputDirectory = join(process.cwd(), "output");
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const sanitizeFileName = (title) => {
    const t = title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "").slice(0, 200);
    if (!t) return "Untitled";
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(t) ? `_${t}` : t;
  };
  const raw = JSON.parse(readFileSync(process.env.FAKE_SCRAPER_NOTES, "utf8"));
  const notes = raw.map((n) => ({
    id: n.id,
    version: n.version ?? 1,
    title: n.content.split(/\r?\n/)[0] || "Untitled",
    content: n.content,
    tags: n.tags ?? [],
    systemTags: n.systemTags ?? ["markdown"],
    creationDate: new Date(n.creationDate ?? "2026-01-01T00:00:00Z"),
    modificationDate: new Date(n.modificationDate ?? "2026-01-02T00:00:00Z"),
  }));
  console.log("connected");
  console.log("authenticated as someone@example.com");
  console.log("received schema");
  for (const note of notes) writeFileSync(join(outputDirectory, `${sanitizeFileName(note.title)}.txt`), note.content, "utf8");
  console.log("\nNOTES:");
  if (mode === "json") console.log(JSON.stringify(notes, null, 2));
  else console.dir(notes, { depth: null });
  console.log("\nmark:", undefined);
  console.log("current:", "abc123");
  console.log("closed:", 1005, "");
}
