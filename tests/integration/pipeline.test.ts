import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DocxRenderer } from "../../src/docx/converter.js";
import { GoogleDriveStore } from "../../src/drive/googleDriveStore.js";
import { createLogger } from "../../src/logging/logger.js";
import { runProcess } from "../../src/scraper/process.js";
import { SimpleNotesScraperSource } from "../../src/scraper/scraperSource.js";
import { StateRepository } from "../../src/state/stateRepository.js";
import { SyncEngine } from "../../src/sync/engine.js";
import { parseDocx } from "../helpers/docx.js";
import { FakeDrive } from "../helpers/fakeDrive.js";
import { tempDir, testConfig } from "../helpers/harness.js";

const FAKE_SCRAPER = fileURLToPath(new URL("../fixtures/fake-scraper.mjs", import.meta.url));

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  delete process.env.FAKE_SCRAPER_NOTES;
});

describe("scraper → markdown → docx → Drive pipeline", () => {
  it("syncs real scraper output end to end, including a note longer than the stdout limit", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const envDir = join(t.dir, "scraper-env");
    mkdirSync(envDir);
    writeFileSync(join(envDir, ".env"), "TOKEN=x\nGMAIL=y\n");
    const longBody = Array.from({ length: 600 }, (_, i) => `- item **${i}**`).join("\n");
    const notes = [
      { id: "3e9ca2f4-f904-434f-8fcf-34e857b1aac2", version: 931, content: "# Current Coding Project Todo\r\n\r\n**GetAIMade:**\r\n```\r\nClean up\r\n```\r\n", systemTags: ["markdown", "pinned"] },
      { id: "long-note", version: 3, content: `# Long Note\n\n${longBody}`, tags: ["big"] },
      { id: "dated", content: "20/10/2023\n\nPlain *text*", systemTags: [] },
    ];
    const notesFile = join(t.dir, "notes.json");
    writeFileSync(notesFile, JSON.stringify(notes));
    process.env.FAKE_SCRAPER_NOTES = notesFile;

    const config = testConfig(t.dir, { simplenote: { env_dir: envDir } });
    const logger = createLogger({ level: "silent", console: false });
    const drive = new FakeDrive();
    const source = new SimpleNotesScraperSource(config.simplenote, logger, {
      resolveExecutable: async () => process.execPath,
      runProcess: (options) => runProcess({ ...options, args: [FAKE_SCRAPER, ...options.args] }),
    });
    const store = new GoogleDriveStore({ settings: config.google_drive, retry: { attempts: 2, initialDelayMs: 1, maxDelayMs: 1 }, logger, api: drive.api() });
    const engine = new SyncEngine({
      config,
      source,
      renderer: new DocxRenderer(config.document),
      remote: async () => store,
      stateRepository: new StateRepository(config.state.file, logger),
      logger,
    });

    const report = await engine.run({ dryRun: false, force: false });
    expect(report.counts).toMatchObject({ discovered: 3, new: 3, failed: 0 });

    const folder = drive.folderByName("Simplenote")!;
    const byName = new Map(drive.filesIn(folder.id).map((f) => [f.name, f]));
    expect([...byName.keys()].sort()).toEqual(["20-10-2023.docx", "Current Coding Project Todo.docx", "Long Note.docx"]);

    const todo = await parseDocx(byName.get("Current Coding Project Todo.docx")!.content!);
    expect(todo.paragraphs[0]).toMatchObject({ text: "Current Coding Project Todo", style: "Heading1" });
    expect(todo.paragraphs[1]!.runs[0]).toMatchObject({ text: "GetAIMade:", bold: true });
    expect(todo.paragraphs[2]!.runs[0]).toMatchObject({ text: "Clean up", font: "Consolas" });

    const long = await parseDocx(byName.get("Long Note.docx")!.content!);
    const items = long.paragraphs.filter((p) => p.numId);
    expect(items).toHaveLength(600);
    expect(items[599]!.text).toBe("item 599");

    const dated = await parseDocx(byName.get("20-10-2023.docx")!.content!);
    expect(dated.paragraphs[1]!.text).toBe("Plain *text*"); // not a Markdown note in Simplenote

    // Second run: scraper output unchanged -> nothing uploaded.
    const before = drive.count("create") + drive.count("update");
    const second = await engine.run({ dryRun: false, force: false });
    expect(second.counts).toMatchObject({ unchanged: 3, new: 0, updated: 0 });
    expect(drive.count("create") + drive.count("update")).toBe(before);
  });
});
