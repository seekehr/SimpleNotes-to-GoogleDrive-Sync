import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/schema.js";
import {
  ScraperExecutionError,
  ScraperNotFoundError,
  ScraperOutputError,
  ScraperTimeoutError,
} from "../../src/errors.js";
import { createLogger } from "../../src/logging/logger.js";
import { TruncatedItems, TruncatedString, parseInspectValue } from "../../src/scraper/inspectParser.js";
import { scraperFileName } from "../../src/scraper/normalize.js";
import { resolveExecutable, runProcess } from "../../src/scraper/process.js";
import { SimpleNotesScraperSource, parseScraperListing } from "../../src/scraper/scraperSource.js";
import { tempDir } from "../helpers/harness.js";

const FAKE_SCRAPER = fileURLToPath(new URL("../fixtures/fake-scraper.mjs", import.meta.url));
const logger = createLogger({ level: "silent", console: false });

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  delete process.env.FAKE_SCRAPER_MODE;
  delete process.env.FAKE_SCRAPER_NOTES;
});

describe("inspect output parser", () => {
  const roundTrip = (value: unknown) => parseInspectValue(inspect(value, { depth: null })).value;

  it("parses what console.dir prints for scraper notes", () => {
    const notes = [
      {
        id: "abc",
        version: 75,
        title: "# Title",
        content: "# Title\r\n\nIt's \"quoted\" `tick` \\ back\ttab \u0001 ctl é 😀",
        tags: ["a", "b-c"],
        systemTags: ["markdown", "pinned"],
        creationDate: new Date("2026-09-18T15:51:56.823Z"),
        modificationDate: null,
      },
    ];
    const parsed = roundTrip(notes) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect({ ...parsed[0] }).toEqual(notes[0]);
  });

  it.each([
    "single 'quote'",
    'double "quote"',
    "both ' and \"",
    "all three ' \" `",
    "line1\nline2\nline3 that is long enough to be split by inspect",
    "\u2028 separators \u2029 and \x7f",
    "lone surrogate \ud800 here",
  ])("round-trips %j", (text) => {
    expect(roundTrip(text)).toBe(text);
  });

  it("surfaces truncated strings with the remaining length", () => {
    const long = "x".repeat(10_050);
    const value = roundTrip(long);
    expect(value).toBeInstanceOf(TruncatedString);
    expect((value as TruncatedString).prefix).toBe("x".repeat(10_000));
    expect((value as TruncatedString).fullLength).toBe(10_050);
  });

  it("surfaces truncated arrays", () => {
    const value = roundTrip(Array.from({ length: 105 }, (_, i) => ({ id: String(i) }))) as unknown[];
    expect(value).toHaveLength(101);
    expect(value[100]).toBeInstanceOf(TruncatedItems);
    expect((value[100] as TruncatedItems).remaining).toBe(5);
  });

  it("parses JSON too", () => {
    expect(parseInspectValue('[{"id":"a","tags":["x"],"n":1.5e2}]').value).toEqual([{ id: "a", tags: ["x"], n: 150 }]);
  });

  it("reports the position of malformed input", () => {
    expect(() => parseInspectValue("[ { id: 'a' ")).toThrow(/offset/);
    expect(() => parseInspectValue("[ [Function: x] ]")).toThrow(/Unexpected token/);
  });
});

describe("parseScraperListing", () => {
  const stdout = (notes: unknown) => `connected\nauthenticated as x@y.z\nreceived schema\n\nNOTES:\n${inspect(notes, { depth: null })}\n\nmark: undefined\ncurrent: abc\nclosed: 1005 \n`;

  it("extracts records and ignores surrounding status lines", () => {
    const { records, missingCount } = parseScraperListing(stdout([{ id: "a", title: "T", content: "T\nbody", tags: [], systemTags: [] }]));
    expect(missingCount).toBe(0);
    expect(records[0]).toMatchObject({ id: "a", content: "T\nbody", scraperTitle: "T" });
  });

  it("fails clearly when the scraper printed no listing (e.g. bad token)", () => {
    try {
      parseScraperListing('connected\nRECV: 0:auth:{"code":401}\nclosed: 1006\n');
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ScraperExecutionError);
      expect((error as ScraperExecutionError).details?.status).toContain("RECV");
      expect((error as ScraperExecutionError).retryable).toBe(true);
    }
  });

  it("rejects entries without an id and skips duplicate ids", () => {
    expect(() => parseScraperListing(stdout([{ title: "x" }]))).toThrow(ScraperOutputError);
    const { records, warnings } = parseScraperListing(stdout([{ id: "a", content: "1" }, { id: "a", content: "2" }]));
    expect(records).toHaveLength(1);
    expect(warnings[0]).toMatch(/Duplicate/);
  });
});

describe("scraperFileName", () => {
  it("matches SimpleNotesScraper's own sanitization", () => {
    expect(scraperFileName("# Prayer Notes (Ayt. Sistani)")).toBe("# Prayer Notes (Ayt. Sistani)");
    expect(scraperFileName("20/10/2023")).toBe("20_10_2023");
    expect(scraperFileName("ends with dots... ")).toBe("ends with dots");
    expect(scraperFileName("")).toBe("Untitled");
    expect(scraperFileName("con")).toBe("_con");
  });
});

describe("process runner", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('out é'); console.error('err'); process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.stdout.trim()).toBe("out é");
    expect(result.stderr.trim()).toBe("err");
  });

  it("kills a process that exceeds the timeout", async () => {
    const result = await runProcess({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  });

  it("resolves executables on PATH (including Windows PATHEXT)", async () => {
    expect(await resolveExecutable("node")).toBeTruthy();
    expect(await resolveExecutable("definitely-not-a-real-command-xyz")).toBeUndefined();
    expect(await resolveExecutable(process.execPath)).toBeTruthy();
  });
});

describe("SimpleNotesScraperSource", () => {
  function setup(notes: unknown[], settings: Partial<AppConfig["simplenote"]> = {}) {
    const t = tempDir();
    cleanup = t.cleanup;
    const envDir = join(t.dir, "env");
    mkdirSync(envDir);
    writeFileSync(join(envDir, ".env"), "TOKEN=x\nGMAIL=y\n");
    const notesFile = join(t.dir, "notes.json");
    writeFileSync(notesFile, JSON.stringify(notes));
    process.env.FAKE_SCRAPER_NOTES = notesFile;
    const workDir = join(t.dir, "work");
    const source = new SimpleNotesScraperSource(
      {
        scraper_command: "fake",
        scraper_args: [],
        env_dir: envDir,
        timeout_seconds: 30,
        work_dir: workDir,
        output_dir: join(workDir, "output"),
        ...settings,
      },
      logger,
      {
        resolveExecutable: async () => process.execPath,
        runProcess: (options) => runProcess({ ...options, args: [FAKE_SCRAPER, ...options.args] }),
      },
    );
    return { source, dir: t.dir, workDir };
  }

  it("runs the scraper and normalizes notes at the boundary", async () => {
    const { source } = setup([
      { id: "n1", version: 7, content: "# Project Notes\r\n\r\nThis is **important**.", tags: ["work"], systemTags: ["markdown", "pinned"] },
      { id: "n2", content: "Plain", systemTags: [] },
    ]);
    const result = await source.fetchNotes();
    expect(result.complete).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toMatchObject({
      id: "n1",
      title: "Project Notes",
      content: "# Project Notes\n\nThis is **important**.",
      tags: ["work"],
      isMarkdown: true,
      revision: "7",
    });
    expect(result.notes[0]!.createdAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(result.notes[1]).toMatchObject({ isMarkdown: false, title: "Plain" });
  });

  it("recovers long notes truncated in stdout from the scraper's .txt file", async () => {
    const long = `Long Note\n${"word ".repeat(4000)}end`;
    const { source } = setup([{ id: "long", content: long }]);
    const result = await source.fetchNotes();
    expect(result.notes[0]!.content).toBe(long);
  });

  it("fails only the affected note when a long note's file was overwritten by a same-titled note", async () => {
    const long = `Same Title\n${"a".repeat(12_000)}`;
    const { source } = setup([
      { id: "long", content: long },
      { id: "short", content: "Same Title\nshort body" },
      { id: "other", content: "Other" },
    ]);
    const result = await source.fetchNotes();
    expect(result.notes.map((n) => n.id).sort()).toEqual(["other", "short"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ id: "long" });
    expect(result.failures[0]!.error).toBeInstanceOf(ScraperOutputError);
  });

  it("understands a JSON listing as well", async () => {
    process.env.FAKE_SCRAPER_MODE = "json";
    const { source } = setup([{ id: "j", content: "From JSON" }]);
    const result = await source.fetchNotes();
    expect(result.notes[0]).toMatchObject({ id: "j", title: "From JSON" });
    expect(result.notes[0]!.createdAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("marks the listing incomplete when more than 100 notes are truncated", async () => {
    const { source } = setup(Array.from({ length: 103 }, (_, i) => ({ id: `n${i}`, content: `Note ${i}` })));
    const result = await source.fetchNotes();
    expect(result.complete).toBe(false);
    expect(result.notes).toHaveLength(100);
    expect(result.warnings.join(" ")).toMatch(/truncated: 3 note/);
  });

  it("raises ScraperTimeoutError when the scraper hangs", async () => {
    process.env.FAKE_SCRAPER_MODE = "hang";
    const { source } = setup([], { timeout_seconds: 0.5 });
    await expect(source.fetchNotes()).rejects.toBeInstanceOf(ScraperTimeoutError);
  });

  it("raises ScraperExecutionError with stderr when the scraper crashes", async () => {
    process.env.FAKE_SCRAPER_MODE = "crash";
    const { source } = setup([]);
    await expect(source.fetchNotes()).rejects.toThrow(/exited with code 1.*TOKEN and GMAIL/s);
  });

  it("detects a run that exits 0 without producing notes", async () => {
    process.env.FAKE_SCRAPER_MODE = "no-listing";
    const { source } = setup([]);
    await expect(source.fetchNotes()).rejects.toThrow(/without printing a NOTES listing/);
  });

  it("gives a meaningful error when the executable is missing", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    const source = new SimpleNotesScraperSource(
      { scraper_command: "no-such-scraper-xyz", scraper_args: [], env_dir: t.dir, timeout_seconds: 5, work_dir: t.dir, output_dir: t.dir },
      logger,
    );
    const error = await source.fetchNotes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScraperNotFoundError);
    expect((error as ScraperNotFoundError).message).toMatch(/no-such-scraper-xyz/);
    expect((error as ScraperNotFoundError).hint).toMatch(/npm link/);
  });

  it("gives a meaningful error when the environment directory does not exist", async () => {
    const { source } = setup([], { env_dir: "Z:\\definitely\\missing" });
    await expect(source.fetchNotes()).rejects.toThrow(/environment directory does not exist/);
  });

  it("runs the scraper inside work_dir so it cannot wipe another output folder", async () => {
    const { source, workDir } = setup([{ id: "a", content: "A" }]);
    await source.fetchNotes();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(workDir, "output"))).toEqual(["A.txt"]);
  });
});
